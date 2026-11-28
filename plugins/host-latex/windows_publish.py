"""Publish a PDF using directory-relative Windows handles, including the final rename."""

import ctypes as C
from ctypes import wintypes as W
from contextlib import ExitStack, contextmanager
import msvcrt
import os
from pathlib import Path
import re
import shutil
import time
import uuid


class UnicodeString(C.Structure):
    _fields_ = [("length", W.USHORT), ("maximum", W.USHORT), ("buffer", W.LPWSTR)]


class ObjectAttributes(C.Structure):
    _fields_ = [("length", W.ULONG), ("parent", W.HANDLE), ("name", C.POINTER(UnicodeString)),
                ("attributes", W.ULONG), ("security", W.LPVOID), ("qos", W.LPVOID)]


class IoStatusBlock(C.Structure):
    _fields_ = [("status", W.LPVOID), ("information", C.c_size_t)]


class RenameInfo(C.Structure):
    _fields_ = [("replace", C.c_ubyte), ("directory", W.HANDLE), ("length", W.ULONG),
                ("name", W.WCHAR * 1)]


class AttributeTagInfo(C.Structure):
    _fields_ = [("attributes", W.DWORD), ("tag", W.DWORD)]


nt = C.WinDLL("ntdll")
kernel = C.WinDLL("kernel32", use_last_error=True)
nt.NtCreateFile.argtypes = [C.POINTER(W.HANDLE), W.DWORD, C.POINTER(ObjectAttributes),
                            C.POINTER(IoStatusBlock), W.LPVOID, W.ULONG, W.ULONG,
                            W.ULONG, W.ULONG, W.LPVOID, W.ULONG]
nt.NtSetInformationFile.argtypes = [W.HANDLE, C.POINTER(IoStatusBlock), W.LPVOID, W.ULONG, W.ULONG]
nt.RtlNtStatusToDosError.argtypes = [W.LONG]
nt.RtlNtStatusToDosError.restype = W.ULONG
kernel.GetFileInformationByHandleEx.argtypes = [W.HANDLE, C.c_int, W.LPVOID, W.DWORD]
kernel.CloseHandle.argtypes = [W.HANDLE]

FILE_OPEN, FILE_CREATE, FILE_OPEN_IF = 1, 2, 3
READ_ATTRIBUTES, TRAVERSE, WRITE_DATA, DELETE = 0x80, 0x20, 0x2, 0x10000
DIRECTORY, NON_DIRECTORY = 1, 0x40
SHARE_READ_WRITE, SHARE_ALL = 3, 7
FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT = 0x10, 0x400
FILE_RENAME_INFORMATION, FILE_DISPOSITION_INFORMATION = 10, 13
FILE_ATTRIBUTE_TAG_INFO = 9
OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE = 0x40, 0x1000
SYNCHRONIZE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT = 0x100000, 0x200000, 0x20


def checked(status):
    if status < 0:
        raise C.WinError(nt.RtlNtStatusToDosError(status))


@contextmanager
def opened(parent, name, access, disposition, kind, sharing):
    # Only the volume/share anchor is absolute. Every other name is one
    # component, interpreted by the filesystem relative to an open directory.
    size = len(name.encode("utf-16-le"))
    string = UnicodeString(size, size, name)
    handle = W.HANDLE()
    # The drive anchor uses a DOS-device mapping. No reparse is needed below it.
    flags = OBJ_CASE_INSENSITIVE | (OBJ_DONT_REPARSE if parent is not None else 0)
    attrs = ObjectAttributes(C.sizeof(ObjectAttributes), parent, C.pointer(string), flags, None, None)
    options = kind | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT
    checked(nt.NtCreateFile(C.byref(handle), access | SYNCHRONIZE, C.byref(attrs),
                            C.byref(IoStatusBlock()), None, 0, sharing, disposition,
                            options, None, 0))
    try:
        mode = os.O_WRONLY if access & WRITE_DATA else os.O_RDONLY
        fd = msvcrt.open_osfhandle(handle.value, os.O_BINARY | mode)
    except BaseException:
        kernel.CloseHandle(handle)
        raise
    try:
        yield fd
    finally:
        os.close(fd)


def attributes(fd):
    result = AttributeTagInfo()
    if not kernel.GetFileInformationByHandleEx(msvcrt.get_osfhandle(fd), FILE_ATTRIBUTE_TAG_INFO,
                                              C.byref(result), C.sizeof(result)):
        raise C.WinError(C.get_last_error())
    return result.attributes


def directory(stack, parent, name, disposition):
    # Omitting delete sharing keeps an open directory from being moved from
    # this project. Share writes so normal editing and child renames still work.
    fd = stack.enter_context(opened(parent, name, TRAVERSE | READ_ATTRIBUTES, disposition,
                                    DIRECTORY, SHARE_READ_WRITE))
    flags = attributes(fd)
    if flags & FILE_ATTRIBUTE_REPARSE_POINT or not flags & FILE_ATTRIBUTE_DIRECTORY:
        raise OSError("Output directory is not a plain directory")
    return fd


def components(path):
    path = Path(path)
    if (path.anchor or len(path.parts) < 2 or path.parts[0] != ".latex-out" or path.suffix.lower() != ".pdf"
            or any(p in (".", "..") or p.endswith((" ", ".")) or ":" in p or "\x00" in p for p in path.parts)):
        raise ValueError("Invalid output path")
    return path.parts


def set_information(fd, buffer, kind):
    checked(nt.NtSetInformationFile(msvcrt.get_osfhandle(fd), C.byref(IoStatusBlock()),
                                    C.byref(buffer), C.sizeof(buffer), kind))


def rename_to(fd, parent, name):
    encoded = name.encode("utf-16-le")
    buffer = C.create_string_buffer(max(C.sizeof(RenameInfo), RenameInfo.name.offset + len(encoded)))
    info = RenameInfo.from_buffer(buffer)
    info.replace, info.directory, info.length = 1, parent, len(encoded)
    C.memmove(C.addressof(buffer) + RenameInfo.name.offset, encoded, len(encoded))
    # Another publisher may still hold its just-renamed temporary handle for
    # the few instructions before close. Retry the same anchored rename only.
    for delay in (0.005, 0.015, 0.045, None):
        try:
            set_information(fd, buffer, FILE_RENAME_INFORMATION)
            return
        except PermissionError as error:
            if delay is None or error.winerror not in (5, 32):
                raise
            time.sleep(delay)


class Publisher:
    def __init__(self, root_fd, stack, destination):
        identity = os.fstat(root_fd)
        self.root_identity = (identity.st_dev, identity.st_ino)
        self.directories = {(): msvcrt.get_osfhandle(root_fd)}
        self.stack = stack
        self.destination = destination

    def walk(self, parts, create):
        for depth, name in enumerate(parts, 1):
            key = parts[:depth]
            if key not in self.directories:
                parent = self.directories[key[:-1]]
                try:
                    fd = directory(self.stack, parent, name, FILE_OPEN_IF if create else FILE_OPEN)
                except FileNotFoundError:
                    if create:
                        raise
                    return
                self.directories[key] = msvcrt.get_osfhandle(fd)
        return self.directories[parts]

    def publish(self, compiled, relative_pdf):
        parts = components(relative_pdf)
        if self.destination is not None and parts != self.destination:
            raise ValueError("Output differs from the selected destination")
        parent = self.walk(parts[:-1], create=True)
        try:
            with opened(parent, parts[-1], READ_ATTRIBUTES, FILE_OPEN, NON_DIRECTORY, SHARE_ALL) as old:
                if attributes(old) & FILE_ATTRIBUTE_REPARSE_POINT:
                    raise OSError("Output file is a reparse point")
        except FileNotFoundError:
            pass
        temporary = ".latex-" + uuid.uuid4().hex + ".tmp"
        with opened(parent, temporary, WRITE_DATA | DELETE, FILE_CREATE, NON_DIRECTORY, 0) as fd:
            try:
                with open(compiled, "rb") as source, os.fdopen(fd, "wb", closefd=False) as output:
                    shutil.copyfileobj(source, output)
                rename_to(fd, parent, parts[-1])
            except BaseException:
                # Dispose only the temporary file we still own by handle.
                set_information(fd, C.c_ubyte(1), FILE_DISPOSITION_INFORMATION)
                raise


def native_anchor(anchor):
    if anchor.upper().startswith("\\\\?\\UNC\\"):
        anchor = "\\\\" + anchor[8:]
    elif anchor.startswith("\\\\?\\"):
        anchor = anchor[4:]
    if re.fullmatch(r"[a-zA-Z]:\\", anchor):
        return "\\??\\" + anchor
    if anchor.startswith("\\\\") and anchor.endswith("\\"):
        parts = anchor[2:-1].split("\\")
        if len(parts) == 2 and all(p and p not in (".", "..", "?") for p in parts):
            return "\\??\\UNC\\" + anchor[2:]
    raise OSError("Expected a drive or a network share")


@contextmanager
def pin_project(root, relative_pdf=None):
    root = Path(root)
    if not root.is_absolute() or ".." in root.parts:
        raise OSError("Expected an absolute project root")
    destination = components(relative_pdf) if relative_pdf is not None else None
    with ExitStack() as stack:
        fd = directory(stack, None, native_anchor(root.anchor), FILE_OPEN)
        for name in root.parts[1:]:
            fd = directory(stack, msvcrt.get_osfhandle(fd), name, FILE_OPEN)
        publisher = Publisher(fd, stack, destination)
        if destination is not None:
            publisher.walk(destination[:-1], create=False)
        yield publisher
