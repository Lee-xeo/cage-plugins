# MCP server for the Linux Files page: lists folders, describes files and
# copies files or zipped folders into a folder shared with the user's computer.
# Every tool is for the plugin's own page only (_meta.ui.visibility: ["app"]).
# Standard input and output carry newline-delimited JSON-RPC; Python's
# standard library only.
import errno
import grp
import json
import mimetypes
import os
import pwd
import re
import stat
import sys
import threading
import time
import uuid
import zipfile

VERSION = "0.2.8"
PAGE_ONLY = {"ui": {"visibility": ["app"]}}
MAX_SCAN = 50000          # entries read from one folder before giving up
DEFAULT_LIMIT = 300
MAX_LIMIT = 1000
PREVIEW_BYTES = 4096
PREVIEW_MAX_FILE = 2 * 1024 * 1024
COUNT_LIMIT = 10000
# Pseudo file systems: reading them can block or never end.
SPECIAL_ROOTS = ("/proc", "/sys", "/dev")
SHARED_TYPES = ("fuse.sshfs", "virtiofs", "9p")
# Kernel file systems that can be mounted anywhere (a chroot's /proc, say):
# recognised by device, wherever they are mounted.
PSEUDO_TYPES = {"proc", "sysfs", "devtmpfs", "devpts", "debugfs", "tracefs", "securityfs", "cgroup",
                "cgroup2", "pstore", "bpf", "configfs", "fusectl", "mqueue", "hugetlbfs", "binfmt_misc",
                "efivarfs", "autofs", "rpc_pipefs", "nsfs"}
EXPORT_SUBFOLDER = "Downloads"
MAX_NAME_TRIES = 10000     # "name (2)", "name (3)", … before giving up


def tool(name, description, properties, required=()):
    return {
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": list(required)},
        "_meta": PAGE_ONLY,
    }


PATH = {"type": "string", "description": "Absolute path."}
TOOLS = [
    tool("list_directory", "List one folder: names, kinds, sizes, permissions and modification times, folders first.",
         {"path": PATH,
          "offset": {"type": "integer", "minimum": 0, "description": "Index of the first entry to return."},
          "limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT, "description": "Most entries to return."},
          "hidden": {"type": "boolean", "description": "Include names that start with a dot."}},
         ["path"]),
    tool("path_details", "Describe one file or folder, with a short text preview for small text files.",
         {"path": PATH}, ["path"]),
    tool("places", "Starting points: the home folder, the root folder and the folders shared with the user's computer.",
         {}),
    tool("remember_destination", "Remember the shared folder that downloads go to, or forget it so the page asks each time.",
         {"destination": {"type": ["string", "null"], "description": "A shared folder returned by places, or null to forget."}},
         ["destination"]),
    tool("export_start", "Copy a file, or a folder as a zip archive, into the Downloads folder of a shared folder.",
         {"path": PATH,
          "destination": {"type": "string", "description": "A shared folder returned by places."}},
         ["path", "destination"]),
    tool("export_status", "Progress of a copy started with export_start.",
         {"job": {"type": "string"}}, ["job"]),
    tool("export_cancel", "Stop a copy started with export_start.",
         {"job": {"type": "string"}}, ["job"]),
]


class Refused(Exception):
    """A failure that is reported to the page as a tool error."""


# ---------------------------------------------------------------- paths

def absolute(path):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise Refused("Give an absolute path.")
    # POSIX lets normpath keep a leading "//" ("//proc" stays "//proc"); Linux
    # treats it as "/", so fold it first.
    return os.path.normpath("/" + path.lstrip("/"))


def under(path, roots):
    return any(path == root or path.startswith(root + "/") for root in roots)


def off_limits(path):
    """True for "/" and the pseudo file systems, judged after following links."""
    real = os.path.realpath(path)
    if real == "/" or under(real, SPECIAL_ROOTS):
        return True
    try:
        return os.stat(real).st_dev in pseudo_devices()
    except OSError:
        return False  # the caller's own stat or open reports it


def kind_of(mode):
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def natural_key(name):
    parts = re.split(r"(\d+)", name.casefold())
    return [(0, int(part), part) if part.isdigit() else (1, 0, part) for part in parts]


def user_name(uid):
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def group_name(gid):
    try:
        return grp.getgrgid(gid).gr_name
    except KeyError:
        return str(gid)


def os_message(error):
    reason = error.strerror or str(error)
    return f"{reason}: {error.filename}" if error.filename else reason


# ---------------------------------------------------------------- listing

def describe_entry(entry):
    item = {"name": entry.name, "hidden": entry.name.startswith(".")}
    try:
        info = entry.stat(follow_symlinks=False)
    except OSError:
        item.update(kind="unknown")
        return item
    item.update(kind=kind_of(info.st_mode), mode=stat.filemode(info.st_mode),
                size=info.st_size, modified=int(info.st_mtime))
    if item["kind"] == "symlink":
        try:
            target = os.stat(entry.path)
            item["target_kind"] = kind_of(target.st_mode)
            item["size"] = target.st_size
        except OSError:
            item["target_kind"] = "broken"
    return item


def is_folder(item):
    return item["kind"] == "directory" or item.get("target_kind") == "directory"


def list_directory(args):
    path = absolute(args.get("path"))
    hidden = bool(args.get("hidden", False))
    offset = max(0, int(args.get("offset", 0) or 0))
    limit = min(MAX_LIMIT, max(1, int(args.get("limit", DEFAULT_LIMIT) or DEFAULT_LIMIT)))
    items, hidden_count, truncated = [], 0, False
    try:
        with os.scandir(path) as scan:
            for count, entry in enumerate(scan):
                if count >= MAX_SCAN:
                    truncated = True
                    break
                item = describe_entry(entry)
                if item["hidden"]:
                    hidden_count += 1
                    if not hidden:
                        continue
                items.append(item)
    except NotADirectoryError:
        raise Refused(f"Not a folder: {path}")
    except OSError as error:
        raise Refused(os_message(error))
    items.sort(key=lambda item: (0 if is_folder(item) else 1, natural_key(item["name"])))
    return {
        "path": path,
        "parent": None if path == "/" else os.path.dirname(path),
        "total": len(items),
        "hidden_count": hidden_count,
        "offset": offset,
        "entries": items[offset:offset + limit],
        "truncated": truncated,
    }


# ---------------------------------------------------------------- details

def text_preview(path, info):
    if not stat.S_ISREG(info.st_mode) or info.st_size > PREVIEW_MAX_FILE or off_limits(path):
        return None
    try:
        with open_regular(os.path.realpath(path)) as file:
            data = file.read(PREVIEW_BYTES)
    except OSError:
        return None
    if b"\0" in data:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        # A multi-byte character cut at the end of the sample is still text.
        if error.start < len(data) - 3:
            return None
        text = data[:error.start].decode("utf-8")
    return {"text": text, "complete": info.st_size <= PREVIEW_BYTES}


def path_details(args):
    path = absolute(args.get("path"))
    try:
        link = os.lstat(path)
    except OSError as error:
        raise Refused(os_message(error))
    details = {
        "path": path,
        "name": os.path.basename(path) or "/",
        "kind": kind_of(link.st_mode),
        "mode": stat.filemode(link.st_mode),
        "octal": oct(stat.S_IMODE(link.st_mode))[2:].zfill(4),
        "owner": user_name(link.st_uid),
        "group": group_name(link.st_gid),
        "size": link.st_size,
        "modified": int(link.st_mtime),
        "accessed": int(link.st_atime),
        "changed": int(link.st_ctime),
        "readable": os.access(path, os.R_OK),
        "writable": os.access(path, os.W_OK),
    }
    info = link
    if stat.S_ISLNK(link.st_mode):
        try:
            details["link_target"] = os.readlink(path)
        except OSError:
            pass
        try:
            info = os.stat(path)
            details["target_kind"] = kind_of(info.st_mode)
            details["size"] = info.st_size
            details["real_path"] = os.path.realpath(path)
        except OSError:
            details["target_kind"] = "broken"
            return details
    if stat.S_ISDIR(info.st_mode):
        count = 0
        try:
            with os.scandir(path) as scan:
                for _ in scan:
                    count += 1
                    if count >= COUNT_LIMIT:
                        break
            details["items"] = count
            details["items_capped"] = count >= COUNT_LIMIT
        except OSError:
            pass
    elif stat.S_ISREG(info.st_mode):
        details["mime"] = mimetypes.guess_type(path)[0]
        preview = text_preview(path, info)
        if preview:
            details["preview"] = preview
    return details


# ---------------------------------------------------------------- shared folders

def unescape_mount(field):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), field)


def parse_mounts(mountinfo):
    """(mount point, file system type, device, options) for each line of mountinfo text."""
    for line in mountinfo.splitlines():
        left, sep, right = line.partition(" - ")
        if not sep:
            continue
        fields, tail = left.split(), right.split()
        if len(fields) < 6 or not tail:
            continue
        try:
            major, minor = (int(number) for number in fields[2].split(":"))
        except ValueError:
            continue
        options = fields[5].split(",")
        if len(tail) > 2:
            options += tail[2].split(",")  # the superblock's options can be read-only too
        yield unescape_mount(fields[4]), tail[0], os.makedev(major, minor), options


def shared_mounts(mountinfo):
    """Writable folders served from the user's computer, as {mount point: device}."""
    found = {}
    for point, fstype, device, options in parse_mounts(mountinfo):
        if not any(fstype == shared or fstype.startswith(shared + ".") for shared in SHARED_TYPES):
            continue
        if "ro" in options or under(point, SPECIAL_ROOTS) or point in found:
            continue
        found[point] = device
    return found


def read_mountinfo(override=True):
    # LINUX_FILES_MOUNTINFO is for tests only: Cage starts guest plugins with a
    # fixed environment (HOME, USER, PATH, …), never this.
    source = (override and os.environ.get("LINUX_FILES_MOUNTINFO")) or "/proc/self/mountinfo"
    try:
        with open(source, encoding="utf-8", errors="replace") as file:
            return file.read()
    except OSError:
        return ""


def pseudo_devices():
    """Devices of the kernel's pseudo file systems, always from the real mount table."""
    return {device for _, fstype, device, _ in parse_mounts(read_mountinfo(override=False))
            if fstype in PSEUDO_TYPES}


def shared_folders():
    folders = []
    for point, device in shared_mounts(read_mountinfo()).items():
        # A single shared file is bound onto its own path: folders only.
        if os.path.isdir(point):
            folders.append({"path": point, "device": device})
    for folder in folders:
        folder["writable"] = os.access(folder["path"], os.W_OK)
        folder["has_downloads"] = os.path.isdir(os.path.join(folder["path"], EXPORT_SUBFOLDER))
    return folders


def suggested(folders):
    writable = [folder for folder in folders if folder["writable"]]
    for rule in (lambda folder: folder["has_downloads"],
                 lambda folder: True):
        for folder in writable:
            if rule(folder):
                return folder["path"]
    return None


def preferences_path():
    return os.path.join(os.path.expanduser("~"), ".config", "linux-files", "preferences.json")


def load_preferences():
    try:
        with open(preferences_path(), encoding="utf-8") as file:
            data = json.load(file)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_preferences(data):
    path = preferences_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)
        file.write("\n")
    os.replace(temporary, path)


def remembered(folders):
    """The folder downloads go to without asking, while it's still shared and writable."""
    usable = {folder["path"] for folder in folders if folder["writable"]}
    saved = load_preferences().get("download_folder")
    return saved if isinstance(saved, str) and saved in usable else None


def places(_args):
    folders = shared_folders()
    home = os.path.expanduser("~")
    shared = [{key: value for key, value in folder.items() if key != "device"} for folder in folders]
    return {"home": home, "root": "/", "shared": shared, "suggested": suggested(folders),
            "remembered": remembered(folders), "export_subfolder": EXPORT_SUBFOLDER}


def remember_destination(args):
    if "destination" not in args:
        raise Refused("Give a shared folder, or null to forget the saved one.")
    destination = args["destination"]
    preferences = load_preferences()
    if destination is None:
        preferences.pop("download_folder", None)
    else:
        export_target(destination)  # refuses folders that are not shared and writable
        preferences["download_folder"] = destination
    try:
        save_preferences(preferences)
    except OSError as error:
        raise Refused(os_message(error))
    return places({})


# ---------------------------------------------------------------- export

JOBS = {}
JOBS_LOCK = threading.Lock()


class Cancelled(Exception):
    pass


def export_target(destination):
    folders = shared_folders()
    match = next((folder for folder in folders if folder["path"] == destination), None)
    if match is None:
        raise Refused("That folder is not shared with your computer.")
    if not match["writable"]:
        raise Refused(f"Cannot write to {destination}.")
    return match


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
CREATE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC


def open_downloads(share_folder):
    """Opens the share's Downloads folder, creating it if needed, as a descriptor.

    The export writes only relative to that descriptor, so it stays in the folder
    checked here even if a path is changed later. The share must still be the
    mounted one (by device), so an unmounted share's empty mount point is never
    written to; Downloads is opened without following links: one pointing
    elsewhere is refused, not followed."""
    destination = share_folder["path"]
    folder = os.path.join(destination, EXPORT_SUBFOLDER)
    try:
        share = os.open(destination, DIRECTORY_FLAGS)
        try:
            if os.fstat(share).st_dev != share_folder["device"]:
                raise Refused(f"{destination} is no longer shared with your computer.")
            try:
                os.mkdir(EXPORT_SUBFOLDER, dir_fd=share)
            except FileExistsError:
                pass
            downloads = os.open(EXPORT_SUBFOLDER, DIRECTORY_FLAGS, dir_fd=share)
        finally:
            os.close(share)
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refused(f"{folder} is a link or a file, not a folder. Rename it to download here.")
        raise Refused(os_message(error))
    return downloads


def candidate_names(name):
    stem, dot, extension = name.partition(".") if not name.startswith(".") else (name, "", "")
    yield name
    for number in range(2, MAX_NAME_TRIES):
        yield f"{stem} ({number}){dot}{extension}"


# linkat errors meaning "no hard links here", as opposed to a real failure.
NO_HARD_LINKS = {errno.EPERM, errno.EOPNOTSUPP, errno.ENOTSUP, errno.ENOSYS, errno.EMLINK, errno.EXDEV}


def commit(folder_fd, partial, name):
    """Gives the finished partial file the first free name and returns it.

    Never replaces an existing file, so two exports with the same name that finish
    together both keep their content. A hard link fails if the name is taken; where
    the share has no hard links, the name is first claimed with an exclusive create
    and the partial file is moved onto that placeholder."""
    hard_links = True
    for candidate in candidate_names(name):
        if hard_links:
            try:
                os.link(partial, candidate, src_dir_fd=folder_fd, dst_dir_fd=folder_fd, follow_symlinks=False)
            except FileExistsError:
                continue
            except OSError as error:
                if error.errno not in NO_HARD_LINKS:
                    raise
                hard_links = False
            else:
                try:
                    os.unlink(partial, dir_fd=folder_fd)
                except OSError:
                    pass  # a hidden leftover; the download itself is complete
                return candidate
        try:
            os.close(os.open(candidate, CREATE_FLAGS, 0o600, dir_fd=folder_fd))
        except FileExistsError:
            continue
        try:
            os.rename(partial, candidate, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
        except BaseException:
            try:
                os.unlink(candidate, dir_fd=folder_fd)
            except OSError:
                pass
            raise
        return candidate
    raise OSError(errno.EEXIST, "Too many files with this name", name)


class ReadFailed(Exception):
    """Reading a source file failed partway; wraps the OSError."""


def copy_stream(job, source, target):
    while True:
        if job["cancel"].is_set():
            raise Cancelled()
        try:
            chunk = source.read(1 << 20)
        except OSError as error:
            raise ReadFailed(error) from error
        if not chunk:
            return
        target.write(chunk)
        job["bytes_done"] += len(chunk)


class NotRegular(OSError):
    pass


SOURCE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


def open_regular(path, dir_fd=None):
    """Opens a regular file for reading without following a final link.

    O_NONBLOCK keeps a FIFO swapped in after a check from blocking the open;
    fstat then confirms what was actually opened."""
    fd = os.open(path, SOURCE_FLAGS, dir_fd=dir_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise NotRegular(0, "Not a regular file", path)
        os.set_blocking(fd, True)
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def write_file(job, source_fd, target):
    with os.fdopen(source_fd, "rb", closefd=False) as source:
        copy_stream(job, source, target)
    job["files_done"] = 1


def skip(job, reason):
    job["skipped_count"] += 1
    if len(job["skipped"]) < 5:
        job["skipped"].append(reason)


ZIP_EARLIEST = (1980, 1, 1, 0, 0, 0)
ZIP_LATEST = (2107, 12, 31, 23, 59, 58)


def zip_date(mtime):
    """The file's time, clamped to what a zip header can hold (1980–2107)."""
    try:
        date = time.localtime(mtime)[:6]
    except (OverflowError, OSError, ValueError):
        return ZIP_LATEST if mtime > 0 else ZIP_EARLIEST
    return min(max(date, ZIP_EARLIEST), ZIP_LATEST)


def zip_name(name):
    # Linux names are bytes; one that isn't UTF-8 arrives with surrogate escapes,
    # which zipfile can't encode. Show the bad bytes as U+FFFD instead.
    return name.encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def zip_entry(name, info):
    entry = zipfile.ZipInfo(zip_name(name), zip_date(info.st_mtime))
    # Type and rwx bits only: no setuid, setgid or sticky bits in the archive.
    entry.external_attr = (stat.S_IFMT(info.st_mode) | (info.st_mode & 0o777)) << 16
    entry.file_size = info.st_size
    entry.compress_type = zipfile.ZIP_DEFLATED
    return entry


def write_zip(job, folder_fd, top, target):
    """Zips the folder open as folder_fd, with its entries under top/.

    os.fwalk goes through directory descriptors and never follows links, so a
    folder swapped for a link during the walk is not entered."""
    # The archive is recognised by its inode, so a link or another spelling
    # of the destination folder can't make it zip itself.
    own = os.fstat(target.fileno())
    pseudo = pseudo_devices()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        walk = os.fwalk(".", dir_fd=folder_fd, onerror=lambda error: skip(job, os_message(error)))
        for root, dirs, files, root_fd in walk:
            relative_root = os.path.normpath(os.path.join(top, root))
            if os.fstat(root_fd).st_dev in pseudo:
                dirs[:] = []  # a /proc, /sys or /dev mounted inside the folder
                skip(job, f"Not copied (system folder): {relative_root}")
                continue
            if not files and not dirs:
                archive.writestr(zip_name(relative_root) + "/", b"")
            for name in sorted(files):
                try:
                    info = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
                    if (info.st_dev, info.st_ino) == (own.st_dev, own.st_ino) or not stat.S_ISREG(info.st_mode):
                        continue  # the archive itself; links, pipes, sockets and devices
                    source = open_regular(name, root_fd)
                    opened = os.fstat(source.fileno())
                except OSError as error:
                    # Unreadable, gone since the listing, swapped for a link, or an
                    # I/O error on the mount: leave the file out and carry on.
                    skip(job, f"{error.strerror or error}: {os.path.join(relative_root, name)}")
                    continue
                # Errors writing the archive are not caught here: they fail the export.
                with source, archive.open(zip_entry(os.path.join(relative_root, name), opened), "w",
                                          force_zip64=True) as target:
                    try:
                        copy_stream(job, source, target)
                    except ReadFailed as failure:
                        skip(job, os_message(failure.__cause__) + " (cut short in the archive)")
                        continue
                job["files_done"] += 1


def run_export(job):
    folder_fd, source_fd, partial = job.pop("folder_fd"), job.pop("source_fd"), job["partial"]
    created = False
    try:
        with os.fdopen(os.open(partial, CREATE_FLAGS, 0o666, dir_fd=folder_fd), "wb") as target:
            created = True
            if job["is_folder"]:
                write_zip(job, source_fd, os.path.basename(job["source"]), target)
            else:
                write_file(job, source_fd, target)
        final = commit(folder_fd, partial, job["name"])
        job.update(state="done", result=os.path.join(job["folder"], final))
    except Cancelled:
        job["state"] = "cancelled"
    except Exception as error:  # reported to the page, never raised
        if isinstance(error, ReadFailed):
            error = error.__cause__
        job.update(state="failed", error=os_message(error) if isinstance(error, OSError) else str(error))
    finally:
        if job["state"] != "done" and created:
            try:
                os.unlink(partial, dir_fd=folder_fd)
            except OSError:
                pass
        os.close(folder_fd)
        os.close(source_fd)
        job["finished"] = time.time()


def open_source(source):
    """Opens the file or folder to copy, so the export reads what was checked here.

    Returns the descriptor and its fstat; the path is not used again."""
    try:
        fd = os.open(source, SOURCE_FLAGS)
    except OSError as error:
        raise Refused(os_message(error))
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):
            raise Refused("Only regular files and folders can be copied.")
        if info.st_dev in pseudo_devices():
            raise Refused("This location cannot be copied.")
        os.set_blocking(fd, True)
        return fd, info
    except BaseException:
        os.close(fd)
        raise


def export_start(args):
    asked = absolute(args.get("path"))
    share = export_target(args.get("destination"))
    if off_limits(asked):
        raise Refused("This location cannot be copied.")
    # Copy what a link points to, checked above, and name the copy after the link.
    source = os.path.realpath(asked)
    source_fd, info = open_source(source)
    try:
        folder_fd = open_downloads(share)
    except BaseException:
        os.close(source_fd)
        raise
    is_folder = stat.S_ISDIR(info.st_mode)
    folder = os.path.join(share["path"], EXPORT_SUBFOLDER)
    name = os.path.basename(asked) + (".zip" if is_folder else "")
    job_id = uuid.uuid4().hex
    job = {
        "id": job_id, "state": "running", "source": source, "name": name, "folder": folder,
        "is_folder": is_folder, "bytes_total": None if is_folder else info.st_size,
        "bytes_done": 0, "files_done": 0, "skipped": [], "skipped_count": 0, "started": time.time(),
        # Not named after the file: a long name plus a suffix would exceed NAME_MAX.
        "partial": f".{job_id}.partial",  # relative to folder_fd
        "folder_fd": folder_fd, "source_fd": source_fd,
        "cancel": threading.Event(),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    threading.Thread(target=run_export, args=(job,), daemon=True).start()
    return job_view(job)


def job_view(job):
    view = {key: job.get(key) for key in ("id", "state", "source", "name", "folder", "is_folder",
                                           "bytes_total", "bytes_done", "files_done", "result", "error")}
    view["skipped"] = job["skipped_count"]
    view["skipped_examples"] = list(job["skipped"])
    return view


def find_job(args):
    with JOBS_LOCK:
        job = JOBS.get(args.get("job"))
    if job is None:
        raise Refused("No such copy.")
    return job


def export_status(args):
    return job_view(find_job(args))


def export_cancel(args):
    job = find_job(args)
    job["cancel"].set()
    return job_view(job)


# ---------------------------------------------------------------- protocol

HANDLERS = {
    "list_directory": list_directory,
    "path_details": path_details,
    "places": places,
    "remember_destination": remember_destination,
    "export_start": export_start,
    "export_status": export_status,
    "export_cancel": export_cancel,
}


def call(name, args):
    handler = HANDLERS.get(name)
    if handler is None:
        return {"content": [{"type": "text", "text": f"Unknown tool: {name}"}], "isError": True}
    try:
        result = handler(args if isinstance(args, dict) else {})
    except Refused as refusal:
        return {"content": [{"type": "text", "text": str(refusal)}], "isError": True}
    except (TypeError, ValueError) as error:
        return {"content": [{"type": "text", "text": f"Invalid arguments: {error}"}], "isError": True}
    return {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result}


def answer(message):
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                "serverInfo": {"name": "linux-files", "version": VERSION}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        return call(params.get("name"), params.get("arguments") or {})
    if method == "ping":
        return {}
    return None


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if not isinstance(request, dict) or "id" not in request:
            continue  # notifications need no reply
        result = answer(request)
        reply = {"jsonrpc": "2.0", "id": request["id"]}
        if result is None:
            reply["error"] = {"code": -32601, "message": "method not found"}
        else:
            reply["result"] = result
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
