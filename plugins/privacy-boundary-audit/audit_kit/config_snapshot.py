"""Strictly read-only local path validation helpers."""

import ntpath
import os
from pathlib import Path, PurePath
import stat
import sys
import types


NETWORK_FS_TYPES = {
    "nfs", "nfs4", "cifs", "smb3", "smbfs", "ncpfs", "afs", "9p",
    "fuse.sshfs", "fuse.rclone", "davfs", "webdav",
}


class SnapshotError(Exception):
    """Read-only path validation precondition failed."""


def _windows_drive_type(root):
    import ctypes

    get_drive_type = ctypes.WinDLL("kernel32.dll").GetDriveTypeW
    get_drive_type.argtypes = [ctypes.c_wchar_p]
    get_drive_type.restype = ctypes.c_uint
    return get_drive_type(root)


def _windows_long_path_if_exists(path_str):
    if sys.platform != "win32" or not isinstance(os, types.ModuleType):
        return path_str
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32.dll", use_last_error=True)
    get_long = kernel32.GetLongPathNameW
    get_long.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    get_long.restype = ctypes.c_uint32

    # Resolve longest existing prefix so short 8.3 parent components cannot mask overlap.
    current = path_str
    suffix_parts = []
    while current:
        needed = get_long(current, None, 0)
        if needed > 0:
            buf = ctypes.create_unicode_buffer(needed)
            if get_long(current, buf, needed) > 0:
                resolved = buf.value
                for part in reversed(suffix_parts):
                    resolved = ntpath.join(resolved, part)
                return resolved
            break
        parent, leaf = ntpath.split(current)
        if not leaf or parent == current:
            break
        suffix_parts.append(leaf)
        current = parent
    return path_str


def _check_unix_local_fs(path):
    if sys.platform == "darwin":
        home = Path.home()
        for cloud_dir in (home / "Library" / "Mobile Documents", home / "Library" / "CloudStorage"):
            p_fold = PurePath(os.fspath(path).casefold())
            c_fold = PurePath(os.fspath(cloud_dir).casefold())
            if p_fold == c_fold or p_fold.is_relative_to(c_fold):
                raise SnapshotError("Cloud-synced storage directories are unsupported.")
    elif sys.platform.startswith("linux"):
        try:
            mounts_text = Path("/proc/mounts").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        best_mount = ""
        best_fstype = ""
        target_str = os.fspath(path)
        for line in mounts_text.splitlines():
            parts = line.split()
            if len(parts) < 3:
                continue
            mount_point = parts[1].replace("\\040", " ")
            fstype = parts[2].lower()
            if (
                target_str == mount_point
                or target_str.startswith(mount_point.rstrip("/") + "/")
                or mount_point == "/"
            ):
                if len(mount_point) > len(best_mount):
                    best_mount = mount_point
                    best_fstype = fstype
        if best_fstype in NETWORK_FS_TYPES:
            raise SnapshotError("Network filesystems are unsupported.")


def recorded_path(value):
    """Normalize a path without requiring its drive to be connected."""
    if sys.platform != "win32":
        return Path(os.path.abspath(Path(value).expanduser()))

    expanded = ntpath.expanduser(os.fspath(value)).replace("/", "\\")
    if expanded.casefold().startswith(("\\\\", "\\??\\", "\\device\\", "\\global??\\")):
        raise SnapshotError("Use a local drive-letter path, not a network or device path.")
    drive, tail = ntpath.splitdrive(expanded)
    absolute = ntpath.normpath(expanded) if drive and tail.startswith("\\") else ntpath.abspath(expanded)
    drive, tail = ntpath.splitdrive(absolute)
    if not (
        len(drive) == 2
        and drive[0].isascii()
        and drive[0].isalpha()
        and drive[1] == ":"
        and tail.startswith("\\")
    ):
        raise SnapshotError("Use a local drive-letter path, not a network or device path.")
    return Path(absolute)


def local_path(value):
    path = recorded_path(value)
    if sys.platform == "win32":
        root = ntpath.splitdrive(os.fspath(path))[0] + "\\"
        try:
            drive_type = _windows_drive_type(root)
        except (AttributeError, OSError) as exc:
            raise SnapshotError("Cannot verify that the selected drive is local.") from exc
        # GetDriveTypeW: removable, fixed, optical and RAM drives are local.
        if drive_type not in {2, 3, 5, 6}:
            raise SnapshotError("Use a verified local drive. Network or unavailable drives are unsupported.")
    else:
        _check_unix_local_fs(path)
    return path


def checked_stat(path):
    entry = path.lstat()
    reparse_point = getattr(entry, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    if stat.S_ISLNK(entry.st_mode) or reparse_point:
        raise SnapshotError("The path contains a symbolic link or reparse point.")
    if stat.S_ISREG(entry.st_mode) and getattr(entry, "st_nlink", 1) > 1:
        raise SnapshotError("The path contains a hard-linked file.")
    return entry


def check_ancestors(path, *, allow_missing=False):
    for ancestor in (*reversed(path.parents), path):
        try:
            mode = checked_stat(ancestor).st_mode
        except FileNotFoundError:
            if allow_missing:
                return
            raise
        if not stat.S_ISDIR(mode):
            raise SnapshotError("A directory path contains a non-directory entry.")


def _comparable_path(path):
    raw = os.fspath(path)
    if sys.platform == "win32":
        raw = _windows_long_path_if_exists(raw)
    if os.name == "nt" or sys.platform == "darwin":
        return PurePath(raw.casefold())
    return PurePath(raw)


def path_is_within(candidate, root):
    if candidate.is_relative_to(root):
        return True
    c_cand, c_root = _comparable_path(candidate), _comparable_path(root)
    return c_cand == c_root or c_cand.is_relative_to(c_root)


def paths_overlap(left, right):
    return path_is_within(left, right) or path_is_within(right, left)
