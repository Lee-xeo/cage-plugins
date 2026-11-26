"""Run one TeX engine or PDF driver inside a host filesystem sandbox."""

import os
import re
import subprocess
import sys
from pathlib import Path


def _linux_command(command, base, cwd, roots):
    # Start with an empty filesystem. In particular, do not expose /usr/bin or
    # the user's home directory just to make one executable available.
    executable = Path(command[0])
    libraries = subprocess.run(
        ["/usr/bin/ldd", str(executable.resolve())], cwd=base,
        env={"PATH": os.defpath, "LC_ALL": "C"}, stdin=subprocess.DEVNULL,
        capture_output=True, timeout=5,
    )
    listing = os.fsdecode(libraries.stdout + libraries.stderr)
    if "=> not found" in listing or (libraries.returncode and "statically linked" not in listing):
        raise OSError("Cannot determine compiler libraries")
    deps = []
    for line in listing.splitlines():
        match = re.fullmatch(r"\s*(?:\S+\s+=>\s+)?(/.*?)\s+\(0x[\da-fA-F]+\)\s*", line)
        if match:
            deps.append(Path(match[1]))

    args = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
            "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev"]
    runtime_files = [Path("/etc/ld.so.cache"), Path("/var/cache/fontconfig"),
                     Path("/etc/paperspecs"), Path("/etc/papersize")]
    # Bind library names as reported by ldd, including the ELF interpreter at
    # its required absolute path. A TeX binary's invocation name selects its format.
    for path in dict.fromkeys([*roots, *runtime_files, *deps, executable, executable.resolve()]):
        if path.exists():
            args.extend(["--ro-bind", str(path), str(path)])
    args.extend(["--bind", str(base), str(base), "--remount-ro", "/",
                 "--chdir", str(cwd), "--", *command])
    return args


def _mac_command(command, base, roots):
    executable = Path(command[0])
    system_paths = [Path(p) for p in (
        "/System/Library", "/usr/lib", "/usr/share/icu", "/usr/share/locale",
        "/usr/share/zoneinfo", "/Library/Apple/System/Library",
        "/System/Volumes/Preboot/Cryptexes/OS/usr/lib",
        "/System/Volumes/Preboot/Cryptexes/OS/System/Library",
        "/dev/null", "/dev/random", "/dev/urandom", "/dev/zero",
    )]
    arguments = ["/usr/bin/sandbox-exec"]
    # macOS needs to open the root directory during process startup. The
    # literal rule applies to that directory entry only, never its descendants.
    profile = ["(version 1)", "(deny default)", "(allow sysctl-read)",
               '(allow file-read-data (literal "/"))',
               '(allow mach-lookup (global-name "com.apple.FontObjectsServer")'
               ' (global-name "com.apple.fonts"))']
    # Use sandbox parameters so no filesystem name can become profile syntax.
    def rule(operations, match, path):
        key = "PATH" + str(len(profile))
        arguments.extend(["-D", f"{key}={path}"])
        profile.append(f'(allow {operations} ({match} (param "{key}")))')

    readable = list(dict.fromkeys([*system_paths, *roots, executable, executable.resolve()]))
    parents = set()
    for path in readable:
        if path.exists():
            rule("file-read*", "subpath" if path.is_dir() else "literal", path)
            parents.update(path.parents)
    parents.update(base.parents)
    for path in sorted(parents):
        rule("file-read-metadata", "literal", path)
    rule("file-read* file-write*", "subpath", base)
    rule("file-write-data", "literal", "/dev/null")
    rule("process-exec*", "literal", executable.resolve())
    for path in (executable.resolve(), *[p for p in system_paths if p.is_dir()]):
        rule("file-map-executable", "subpath" if path.is_dir() else "literal", path)
    arguments.extend(["-p", "\n".join(profile), *command])
    return arguments


def run_contained(command, cwd, env, output, timeout, base, allowed):
    """Run a single explicitly selected engine. No unsandboxed fallback."""
    base = Path(base).resolve(strict=True)
    cwd = Path(cwd).resolve(strict=True)
    roots = list(dict.fromkeys(Path(p).resolve(strict=True) for p in allowed))
    if not cwd.is_relative_to(base) or not Path(command[0]).is_absolute():
        raise OSError("Invalid compilation directory or executable")
    roots = [p for p in roots if not p.is_relative_to(base)]
    # An installation-wide setting of '/' or a user's home is not a TeX tree.
    broad = {Path("/"), Path("/usr"), Path("/usr/local"), Path("/etc"), Path("/var"),
             Path("/home"), Path("/Users"), Path("/tmp"), Path.home().resolve()}
    if any(p in broad or base.is_relative_to(p) for p in roots):
        raise OSError("Unsafe TeX data path")
    if sys.platform.startswith("linux"):
        wrapper = _linux_command(command, base, cwd, roots)
    elif sys.platform == "darwin":
        wrapper = _mac_command(command, base, roots)
    else:
        raise OSError("Unsupported sandbox")
    status = subprocess.run(wrapper, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=output, stderr=subprocess.STDOUT, timeout=timeout).returncode
    if status:
        output.seek(0)
        if output.read(32).startswith((b"bwrap:", b"sandbox-exec:")):
            raise OSError("The operating system could not start the sandbox")
    return status
