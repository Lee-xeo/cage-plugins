"""Publish a PDF relative to verified open directory descriptors."""

import os
import secrets
import shutil
import stat
from contextlib import ExitStack, contextmanager


# Linux's O_PATH and POSIX O_SEARCH allow traversal through a search-only
# ancestor. O_RDONLY is the portable fallback for opening a directory.
DIRECTORY_FLAGS = (getattr(os, "O_PATH", getattr(os, "O_SEARCH", os.O_RDONLY))
                   | os.O_DIRECTORY | os.O_NOFOLLOW)


def open_child(stack, chain, name):
    fd = os.open(name, DIRECTORY_FLAGS, dir_fd=chain[-1][1])
    stack.callback(os.close, fd)
    chain.append((name, fd))


def verify_chain(chain):
    for index in range(1, len(chain)):
        name, fd = chain[index]
        entry = os.stat(name, dir_fd=chain[index - 1][1], follow_symlinks=False)
        if not os.path.samestat(entry, os.fstat(fd)):
            raise OSError("Output directory changed")


def check_output_name(relative):
    if (relative.is_absolute() or len(relative.parts) < 2 or relative.parts[0] != ".latex-out"
            or ".." in relative.parts or relative.suffix.lower() != ".pdf"):
        raise ValueError("Invalid output path")


def verify_target(fd, name):
    try:
        entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(entry.st_mode):
        raise OSError("Output is not a regular file")


class Publisher:
    def __init__(self, chain, relative):
        root = os.fstat(chain[-1][1])
        self.root_identity = (root.st_dev, root.st_ino)
        self.root_depth = len(chain)
        self.chain = chain
        self.relative = relative

    def publish(self, compiled, relative):
        check_output_name(relative)
        if self.relative is not None and relative != self.relative:
            raise ValueError("Output differs from the selected destination")
        chain = list(self.chain)
        observed = len(chain) - self.root_depth
        with ExitStack() as stack:
            verify_chain(chain)
            for name in relative.parts[observed:-1]:
                try:
                    open_child(stack, chain, name)
                except FileNotFoundError:
                    verify_chain(chain)
                    try:
                        os.mkdir(name, dir_fd=chain[-1][1])
                    except FileExistsError:
                        # A concurrent publication may have created the directory.
                        pass
                    open_child(stack, chain, name)
            directory = chain[-1][1]
            verify_chain(chain)
            verify_target(directory, relative.name)
            temporary = ".latex-" + secrets.token_hex(16) + ".tmp"
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            handle = os.open(temporary, flags, 0o600, dir_fd=directory)
            with os.fdopen(handle, "wb") as output:
                def verify_temporary():
                    verify_chain(chain)
                    info = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
                    if not os.path.samestat(info, os.fstat(output.fileno())):
                        raise OSError("Temporary PDF changed")

                try:
                    with compiled.open("rb") as source:
                        shutil.copyfileobj(source, output)
                    output.flush()
                    verify_temporary()
                    verify_target(directory, relative.name)
                    os.replace(temporary, relative.name, src_dir_fd=directory, dst_dir_fd=directory)
                except BaseException:
                    # Only remove our file, and only if the original directory
                    # chain is still present. Never retry via an absolute path.
                    try:
                        verify_temporary()
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass
                    raise


@contextmanager
def pin_project(root, relative_pdf=None):
    if not root.is_absolute() or ".." in root.parts:
        raise ValueError("Project root must be absolute")
    with ExitStack() as stack:
        anchor = os.open(root.anchor, DIRECTORY_FLAGS)
        stack.callback(os.close, anchor)
        chain = [(root.anchor, anchor)]
        for name in root.parts[1:]:
            open_child(stack, chain, name)
        publisher = Publisher(chain, relative_pdf)
        if relative_pdf is not None:
            check_output_name(relative_pdf)
            for name in relative_pdf.parts[:-1]:
                try:
                    open_child(stack, chain, name)
                except FileNotFoundError:
                    break
        verify_chain(chain)
        yield publisher
