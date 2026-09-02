// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the shields-up content seal. Centralised so the lock
// path that writes the seal and the status path that re-checks it share
// the same input contract (sha256sum output shape, hex normalisation).

// Single source of truth for the SHA-256 hex shape used across the
// shields module: by the verifier, the lock-time seal capture, and the
// `ShieldsState.fileHashes` schema guard.
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

export function parseSha256Output(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const token = trimmed.split(/\s+/, 1)[0];
  return isSha256Hex(token) ? token.toLowerCase() : null;
}

// Issue-string prefixes the verifier emits for hash-related failures.
// Used by callers that need to classify whether drift is launderable
// (perms-only) or non-launderable (any hash-verification failure).
export const HASH_ISSUE_PATTERNS: readonly string[] = [
  "content drifted",
  "sha256sum failed",
  "sha256sum output unparsable",
  "no seal recorded",
];

export function isHashVerificationIssue(entry: string): boolean {
  return HASH_ISSUE_PATTERNS.some((p) => entry.includes(p));
}

export const CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT = String.raw`
import errno
import grp
import hashlib
import os
import stat
import sys

HASH_NAME = ".config-hash"
MAX_HASH_BYTES = 1024

def die(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(1)

def required_flag(name):
    value = getattr(os, name, None)
    if not isinstance(value, int) or value == 0:
        die("required open flag is unavailable: " + name)
    return value

O_NOFOLLOW = required_flag("O_NOFOLLOW")

def open_checked(path, want_dir, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | O_NOFOLLOW
    if want_dir:
        flags |= getattr(os, "O_DIRECTORY", 0)
    else:
        flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags, dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            die("refusing symlink path: " + path)
        die("open failed for %s: %s" % (path, exc))
    opened = os.fstat(fd)
    mode = opened.st_mode
    if want_dir and not stat.S_ISDIR(mode):
        os.close(fd)
        die("not a directory: " + path)
    if not want_dir and not stat.S_ISREG(mode):
        os.close(fd)
        die("not a regular file: " + path)
    if not want_dir and opened.st_nlink != 1:
        os.close(fd)
        die("refusing multiply linked file: " + path)
    return fd

def config_child_name(config_dir, path):
    normalized_dir = os.path.normpath(config_dir)
    normalized_path = os.path.normpath(path)
    if os.path.dirname(normalized_path) != normalized_dir:
        die("refusing config path outside config dir: " + path)
    name = os.path.basename(normalized_path)
    if name in ("", ".", ".."):
        die("refusing invalid config path: " + path)
    return name

def hash_fd(fd):
    digest = hashlib.sha256()
    while True:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()

def read_limited(fd, path):
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, 1 << 10)
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_HASH_BYTES:
            die("config hash is too large: " + path)
        chunks.append(chunk)

def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino

def inspect_hash_record(dir_fd, config_dir):
    try:
        existing = os.stat(HASH_NAME, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(existing.st_mode):
        die("not a regular file: " + config_dir + "/" + HASH_NAME)
    if existing.st_nlink != 1:
        die("refusing multiply linked file: " + config_dir + "/" + HASH_NAME)
    return existing

config_dir = os.path.normpath(sys.argv[1])
config_name = config_child_name(config_dir, sys.argv[2])
parent_dir = os.path.dirname(config_dir)
config_dir_name = os.path.basename(config_dir)
if parent_dir in ("", config_dir) or config_dir_name in ("", ".", ".."):
    die("refusing invalid config dir: " + config_dir)

parent_fd = open_checked(parent_dir, True)
parent_stat = os.fstat(parent_fd)
parent_mode = stat.S_IMODE(parent_stat.st_mode)
test_protect_parent = len(sys.argv) == 4 and sys.argv[3] == "--test-protect-parent"
if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and not test_protect_parent):
    os.close(parent_fd)
    die("unsupported config hash repair arguments")
protect_parent = parent_dir == "/sandbox" or test_protect_parent
if protect_parent:
    sandbox_gid = (
        os.getegid()
        if test_protect_parent
        else grp.getgrnam("sandbox").gr_gid
    )
else:
    sandbox_gid = None
    if parent_stat.st_uid != os.geteuid():
        os.close(parent_fd)
        die("config parent is not owned by the privileged repair identity: " + parent_dir)
    if (parent_mode & 0o022) and not (parent_mode & stat.S_ISVTX):
        os.close(parent_fd)
        die("refusing writable config parent without sticky protection: " + parent_dir)

dir_fd = None
dir_initial = None
created_hash = False
body_error = None
restore_errors = []
try:
    if protect_parent:
        # /sandbox is mutable by the agent in the normal posture. Freeze it
        # before resolving the config child so the canonical directory cannot
        # be renamed while privileged repair is in progress.
        os.fchown(parent_fd, os.geteuid(), os.getegid())
        os.fchmod(parent_fd, 0o755)

    dir_fd = open_checked(config_dir_name, True, dir_fd=parent_fd)
    dir_initial = os.fstat(dir_fd)

    # Revoke path mutation before inspecting or creating the record. The
    # parent is either already protected or frozen above, so the now-privileged
    # directory cannot be replaced after this descriptor transition.
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o700)
    current_dir = os.stat(config_dir_name, dir_fd=parent_fd, follow_symlinks=False)
    if not same_inode(current_dir, dir_initial):
        die("config directory changed during repair: " + config_dir)

    existing = inspect_hash_record(dir_fd, config_dir)
    config_fd = open_checked(config_name, False, dir_fd=dir_fd)
    try:
        if existing is None:
            digest = hash_fd(config_fd)
    finally:
        os.close(config_fd)

    if existing is None:
        record = ("%s  %s\n" % (digest, config_name)).encode("ascii")
        create_flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | O_NOFOLLOW
        )
        try:
            record_fd = os.open(HASH_NAME, create_flags, 0o444, dir_fd=dir_fd)
            created_hash = True
        except FileExistsError:
            raced = inspect_hash_record(dir_fd, config_dir)
            if raced is None:
                die("config hash changed during repair: " + config_dir + "/" + HASH_NAME)
            raced_fd = open_checked(HASH_NAME, False, dir_fd=dir_fd)
            try:
                opened = os.fstat(raced_fd)
                if not same_inode(raced, opened):
                    die("config hash changed during repair: " + config_dir + "/" + HASH_NAME)
                if read_limited(raced_fd, config_dir + "/" + HASH_NAME) != record:
                    die("competing config hash has unexpected content: " + config_dir + "/" + HASH_NAME)
            finally:
                os.close(raced_fd)
        else:
            try:
                written = 0
                while written < len(record):
                    count = os.write(record_fd, record[written:])
                    if count <= 0:
                        die("short write while creating " + config_dir + "/" + HASH_NAME)
                    written += count
                os.fchown(record_fd, os.geteuid(), os.getegid())
                os.fchmod(record_fd, 0o444)
                os.fsync(record_fd)
            finally:
                os.close(record_fd)

    # Publish a path-stable locked root before returning to the caller's
    # remaining lock operations. The sticky parent still permits ordinary
    # /sandbox use by the sandbox group, but not replacement of this
    # privileged config directory.
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o755)
    os.fsync(dir_fd)
    locked_dir = os.fstat(dir_fd)
    if (
        locked_dir.st_uid != os.geteuid()
        or locked_dir.st_gid != os.getegid()
        or stat.S_IMODE(locked_dir.st_mode) != 0o755
    ):
        die("replacement metadata mismatch for " + config_dir)
    if protect_parent:
        os.fchown(parent_fd, os.geteuid(), sandbox_gid)
        os.fchmod(parent_fd, 0o1775)
        os.fsync(parent_fd)
        locked_parent = os.fstat(parent_fd)
        if (
            locked_parent.st_uid != os.geteuid()
            or locked_parent.st_gid != sandbox_gid
            or stat.S_IMODE(locked_parent.st_mode) != 0o1775
        ):
            die("replacement metadata mismatch for " + parent_dir)
except BaseException as exc:
    body_error = exc
finally:
    if dir_fd is not None:
        if body_error is not None and created_hash:
            try:
                os.unlink(HASH_NAME, dir_fd=dir_fd)
            except OSError as exc:
                restore_errors.append("config hash cleanup: %s" % (exc,))
        if body_error is not None and dir_initial is not None:
            try:
                os.fchown(dir_fd, dir_initial.st_uid, dir_initial.st_gid)
                os.fchmod(dir_fd, stat.S_IMODE(dir_initial.st_mode))
            except OSError as exc:
                restore_errors.append("config dir: %s" % (exc,))
        os.close(dir_fd)
    if body_error is not None and protect_parent:
        try:
            os.fchown(parent_fd, parent_stat.st_uid, parent_stat.st_gid)
            os.fchmod(parent_fd, parent_mode)
        except OSError as exc:
            restore_errors.append("config parent: %s" % (exc,))
    os.close(parent_fd)

if restore_errors:
    die("config hash repair rollback failed: " + "; ".join(restore_errors))
if body_error is not None:
    raise body_error
`;

export function buildConfigHashRepairCommand(configDir: string, configPath: string): string[] {
  return ["python3", "-I", "-c", CONFIG_HASH_REPAIR_NOFOLLOW_SCRIPT, configDir, configPath];
}

// Deep Agents uses a separate fresh-inode lock transaction below; the generic
// absent-record repair above remains unchanged for every other agent.
export const DEEP_AGENTS_CONFIG_LOCK_ERROR_PROTOCOL_PREFIX =
  "NEMOCLAW_DEEP_AGENTS_CONFIG_LOCK_ERROR_V1";

export const DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT = String.raw`
import fcntl
import grp
import hashlib
import os
import secrets
import stat
import struct
import sys

HASH_NAME = ".config-hash"
MAX_CONFIG_BYTES = 16 * 1024 * 1024
MAX_HASH_BYTES = 1024
FS_IMMUTABLE_FL = 0x00000010
FS_IOC_GETFLAGS = 0x80086601
FS_IOC_SETFLAGS = 0x40086602
ERROR_PROTOCOL_PREFIX = ${JSON.stringify(DEEP_AGENTS_CONFIG_LOCK_ERROR_PROTOCOL_PREFIX)}

def die(message):
    raise RuntimeError(message)

def required_flag(name):
    value = getattr(os, name, None)
    if not isinstance(value, int) or value == 0:
        die("required open flag is unavailable: " + name)
    return value

O_NOFOLLOW = required_flag("O_NOFOLLOW")

def open_checked(path, want_dir, dir_fd=None):
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | O_NOFOLLOW
    flags |= getattr(os, "O_DIRECTORY", 0) if want_dir else getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags, dir_fd=dir_fd)
    except OSError as exc:
        die("open failed for %s: %s" % (path, exc))
    opened = os.fstat(fd)
    if want_dir and not stat.S_ISDIR(opened.st_mode):
        os.close(fd)
        die("not a directory: " + path)
    if not want_dir and not stat.S_ISREG(opened.st_mode):
        os.close(fd)
        die("not a regular file: " + path)
    if not want_dir and opened.st_nlink != 1:
        os.close(fd)
        die("refusing multiply linked file: " + path)
    return fd, opened

def open_optional_file(name, dir_fd):
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | O_NOFOLLOW
    )
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        die("open failed for %s: %s" % (name, exc))
    opened = os.fstat(fd)
    if not stat.S_ISREG(opened.st_mode):
        os.close(fd)
        die("not a regular file: " + name)
    if opened.st_nlink != 1:
        os.close(fd)
        die("refusing multiply linked file: " + name)
    return fd, opened

def child_name(config_dir, path):
    normalized = os.path.normpath(path)
    if os.path.dirname(normalized) != config_dir:
        die("refusing config path outside config dir: " + path)
    name = os.path.basename(normalized)
    if name in ("", ".", ".."):
        die("refusing invalid config path: " + path)
    return name

def read_fd(fd, limit, label):
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, min(1 << 16, limit + 1 - total))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            die("file exceeds size limit: " + label)
        chunks.append(chunk)

def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino

def inode_flags(fd):
    try:
        value = bytearray(4)
        fcntl.ioctl(fd, FS_IOC_GETFLAGS, value, True)
        return struct.unpack("I", value)[0]
    except OSError:
        return 0

def clear_immutable(fd):
    flags = inode_flags(fd)
    if flags & FS_IMMUTABLE_FL:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags & ~FS_IMMUTABLE_FL))
    return flags

def set_flags(fd, flags):
    if flags:
        fcntl.ioctl(fd, FS_IOC_SETFLAGS, struct.pack("I", flags))

def saved_file(st, data, flags):
    return {
        "data": data,
        "uid": st.st_uid,
        "gid": st.st_gid,
        "mode": stat.S_IMODE(st.st_mode),
        "flags": flags,
    }

def stage(dir_fd, name, data, uid, gid, mode):
    temp = ".%s.nemoclaw.%d.%s" % (name, os.getpid(), secrets.token_hex(8))
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_CLOEXEC", 0)
        | O_NOFOLLOW
    )
    fd = os.open(temp, flags, 0o600, dir_fd=dir_fd)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                die("short write while staging " + name)
            view = view[count:]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        except BaseException as cleanup_error:
            rollback_errors.append("%s staging cleanup: %s" % (name, cleanup_error))
        raise
    os.close(fd)
    return temp

def replace_saved(dir_fd, name, saved):
    current_fd, _current_st = open_optional_file(name, dir_fd)
    if current_fd is not None:
        try:
            clear_immutable(current_fd)
        finally:
            os.close(current_fd)
    temp = stage(
        dir_fd,
        name,
        saved["data"],
        saved["uid"],
        saved["gid"],
        saved["mode"],
    )
    try:
        os.replace(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    finally:
        try:
            os.unlink(temp, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
    fd, opened = open_checked(name, False, dir_fd=dir_fd)
    try:
        limit = MAX_HASH_BYTES if name == HASH_NAME else MAX_CONFIG_BYTES
        if (
            opened.st_uid != saved["uid"]
            or opened.st_gid != saved["gid"]
            or stat.S_IMODE(opened.st_mode) != saved["mode"]
            or read_fd(fd, limit, name) != saved["data"]
        ):
            die("rollback replacement mismatch for " + name)
        set_flags(fd, saved["flags"])
    finally:
        os.close(fd)

def verify_locked(dir_fd, name, expected):
    fd, opened = open_checked(name, False, dir_fd=dir_fd)
    try:
        limit = MAX_HASH_BYTES if name == HASH_NAME else MAX_CONFIG_BYTES
        if read_fd(fd, limit, name) != expected:
            die("replacement content mismatch for " + name)
        if (
            opened.st_uid != os.geteuid()
            or opened.st_gid != os.getegid()
            or stat.S_IMODE(opened.st_mode) != 0o444
        ):
            die("replacement metadata mismatch for " + name)
        return opened
    finally:
        os.close(fd)

def entry_identity(dir_fd, name):
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None

def clear_entry_immutable(dir_fd, name):
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NONBLOCK", 0)
        | O_NOFOLLOW
    )
    try:
        fd = os.open(name, flags, dir_fd=dir_fd)
    except FileNotFoundError:
        return
    except OSError:
        # Symlinks cannot carry regular-file immutable state. Replacing the
        # no-follow directory entry below still revokes the canonical name.
        return
    try:
        clear_immutable(fd)
    finally:
        os.close(fd)

def install_contained_pair(dir_fd, config_name, config_bytes, record_bytes):
    previous = {
        config_name: entry_identity(dir_fd, config_name),
        HASH_NAME: entry_identity(dir_fd, HASH_NAME),
    }
    containment_staged = {}
    try:
        clear_entry_immutable(dir_fd, config_name)
        clear_entry_immutable(dir_fd, HASH_NAME)
        containment_staged[config_name] = stage(
            dir_fd, config_name, config_bytes, os.geteuid(), os.getegid(), 0o444
        )
        containment_staged[HASH_NAME] = stage(
            dir_fd, HASH_NAME, record_bytes, os.geteuid(), os.getegid(), 0o444
        )
        os.replace(
            containment_staged[config_name],
            config_name,
            src_dir_fd=dir_fd,
            dst_dir_fd=dir_fd,
        )
        containment_staged.pop(config_name)
        os.replace(
            containment_staged[HASH_NAME],
            HASH_NAME,
            src_dir_fd=dir_fd,
            dst_dir_fd=dir_fd,
        )
        containment_staged.pop(HASH_NAME)
        installed_config = verify_locked(dir_fd, config_name, config_bytes)
        installed_hash = verify_locked(dir_fd, HASH_NAME, record_bytes)
        if previous[config_name] is not None and same_inode(
            previous[config_name], installed_config
        ):
            die("containment did not replace config inode")
        if previous[HASH_NAME] is not None and same_inode(
            previous[HASH_NAME], installed_hash
        ):
            die("containment did not replace config hash inode")
        os.fsync(dir_fd)
    finally:
        for name, temp in containment_staged.items():
            try:
                os.unlink(temp, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
            except BaseException as cleanup_error:
                rollback_errors.append(
                    "%s containment staging cleanup: %s" % (name, cleanup_error)
                )

if len(sys.argv) < 3:
    die("unsupported Deep Agents config lock arguments")
options = sys.argv[3:]
allowed_options = {"--fail-closed-on-error", "--test-protect-parent"}
if len(options) != len(set(options)) or any(option not in allowed_options for option in options):
    die("unsupported Deep Agents config lock arguments")

config_dir = os.path.normpath(sys.argv[1])
config_name = child_name(config_dir, sys.argv[2])
fail_closed_on_error = "--fail-closed-on-error" in options
test_parent = "--test-protect-parent" in options
parent_dir = os.path.dirname(config_dir)
dir_name = os.path.basename(config_dir)
if parent_dir in ("", config_dir) or dir_name in ("", ".", ".."):
    die("refusing invalid config dir: " + config_dir)

parent_fd, parent_st = open_checked(parent_dir, True)
parent_saved = {
    "uid": parent_st.st_uid,
    "gid": parent_st.st_gid,
    "mode": stat.S_IMODE(parent_st.st_mode),
    "flags": inode_flags(parent_fd),
}
protect_parent = parent_dir == "/sandbox" or test_parent
sandbox_gid = None
if protect_parent:
    sandbox_gid = os.getegid() if test_parent else grp.getgrnam("sandbox").gr_gid
elif parent_st.st_uid != os.geteuid() or (
    stat.S_IMODE(parent_st.st_mode) & 0o022
    and not stat.S_IMODE(parent_st.st_mode) & stat.S_ISVTX
):
    os.close(parent_fd)
    die("refusing unsafe config parent: " + parent_dir)

dir_fd = None
dir_saved = None
dir_flags = 0
opened = {}
staged = {}
mutation_started = False
body_error = None
rollback_errors = []
hash_created = False
parent_freeze_started = False
freeze_completed = False
containment_attempted = False
containment_result = None
config_bytes = None
record_bytes = None
try:
    if protect_parent:
        parent_freeze_started = True
        clear_immutable(parent_fd)
        os.fchown(parent_fd, os.geteuid(), os.getegid())
        os.fchmod(parent_fd, 0o755)

    dir_fd, dir_st = open_checked(dir_name, True, dir_fd=parent_fd)
    dir_saved = {
        "uid": dir_st.st_uid,
        "gid": dir_st.st_gid,
        "mode": stat.S_IMODE(dir_st.st_mode),
    }
    dir_flags = clear_immutable(dir_fd)
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o700)
    freeze_completed = True
    if not same_inode(os.stat(dir_name, dir_fd=parent_fd, follow_symlinks=False), dir_st):
        die("config directory changed during lock: " + config_dir)

    config_fd, config_st = open_checked(config_name, False, dir_fd=dir_fd)
    opened[config_name] = {"fd": config_fd, "stat": config_st, "saved": None}
    config_bytes = read_fd(config_fd, MAX_CONFIG_BYTES, os.path.join(config_dir, config_name))
    opened[config_name]["saved"] = saved_file(
        config_st,
        config_bytes,
        inode_flags(config_fd),
    )
    record_bytes = (
        "%s  %s\n" % (hashlib.sha256(config_bytes).hexdigest(), config_name)
    ).encode("ascii")

    hash_fd, hash_st = open_optional_file(HASH_NAME, dir_fd)
    hash_created = hash_fd is None
    if hash_fd is not None:
        opened[HASH_NAME] = {"fd": hash_fd, "stat": hash_st, "saved": None}
        hash_bytes = read_fd(hash_fd, MAX_HASH_BYTES, os.path.join(config_dir, HASH_NAME))
        opened[HASH_NAME]["saved"] = saved_file(
            hash_st,
            hash_bytes,
            inode_flags(hash_fd),
        )
        if hash_bytes != record_bytes:
            die("existing config hash is stale or malformed: " + os.path.join(config_dir, HASH_NAME))

    staged[config_name] = stage(
        dir_fd, config_name, config_bytes, os.geteuid(), os.getegid(), 0o444
    )
    staged[HASH_NAME] = stage(
        dir_fd, HASH_NAME, record_bytes, os.geteuid(), os.getegid(), 0o444
    )
    if not same_inode(
        os.stat(config_name, dir_fd=dir_fd, follow_symlinks=False),
        opened[config_name]["stat"],
    ):
        die("config path changed during lock: " + os.path.join(config_dir, config_name))
    if HASH_NAME in opened:
        if not same_inode(
            os.stat(HASH_NAME, dir_fd=dir_fd, follow_symlinks=False),
            opened[HASH_NAME]["stat"],
        ):
            die("config hash changed during lock: " + os.path.join(config_dir, HASH_NAME))
    else:
        try:
            os.stat(HASH_NAME, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            die("config hash appeared during lock: " + os.path.join(config_dir, HASH_NAME))

    mutation_started = True
    clear_immutable(opened[config_name]["fd"])
    if HASH_NAME in opened:
        clear_immutable(opened[HASH_NAME]["fd"])
    os.replace(staged[config_name], config_name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    staged.pop(config_name)
    os.replace(staged[HASH_NAME], HASH_NAME, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    staged.pop(HASH_NAME)
    verify_locked(dir_fd, config_name, config_bytes)
    verify_locked(dir_fd, HASH_NAME, record_bytes)
    os.fchown(dir_fd, os.geteuid(), os.getegid())
    os.fchmod(dir_fd, 0o755)
    os.fsync(dir_fd)
    if protect_parent:
        os.fchown(parent_fd, os.geteuid(), sandbox_gid)
        os.fchmod(parent_fd, 0o1775)
        os.fsync(parent_fd)
except BaseException as exc:
    body_error = exc
    if dir_fd is not None and mutation_started:
        try:
            replace_saved(dir_fd, config_name, opened[config_name]["saved"])
        except BaseException as rollback_error:
            rollback_errors.append("%s: %s" % (config_name, rollback_error))
        if HASH_NAME in opened:
            try:
                replace_saved(dir_fd, HASH_NAME, opened[HASH_NAME]["saved"])
            except BaseException as rollback_error:
                rollback_errors.append("%s: %s" % (HASH_NAME, rollback_error))
        else:
            try:
                os.unlink(HASH_NAME, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
            except BaseException as rollback_error:
                rollback_errors.append("%s cleanup: %s" % (HASH_NAME, rollback_error))
finally:
    if dir_fd is not None:
        for name, temp in staged.items():
            try:
                os.unlink(temp, dir_fd=dir_fd)
            except FileNotFoundError:
                pass
            except BaseException as rollback_error:
                rollback_errors.append("%s staging cleanup: %s" % (name, rollback_error))
    for item in opened.values():
        try:
            os.close(item["fd"])
        except OSError:
            pass
    if body_error is not None:
        contain_on_error = fail_closed_on_error and (
            freeze_completed or parent_freeze_started
        )
        if not contain_on_error and not rollback_errors:
            if dir_fd is not None and dir_saved is not None:
                try:
                    os.fchown(dir_fd, dir_saved["uid"], dir_saved["gid"])
                    os.fchmod(dir_fd, dir_saved["mode"])
                    set_flags(dir_fd, dir_flags)
                except BaseException as rollback_error:
                    rollback_errors.append("config dir: %s" % rollback_error)
            if not rollback_errors:
                try:
                    os.fchown(parent_fd, parent_saved["uid"], parent_saved["gid"])
                    os.fchmod(parent_fd, parent_saved["mode"])
                    set_flags(parent_fd, parent_saved["flags"])
                except BaseException as rollback_error:
                    rollback_errors.append("config parent: %s" % rollback_error)
        if contain_on_error or rollback_errors:
            if contain_on_error:
                containment_attempted = True
                containment_result = "incomplete"

            canonical_pair_contained = False
            if (
                contain_on_error
                and dir_fd is not None
                and config_bytes is not None
                and record_bytes is not None
            ):
                try:
                    install_contained_pair(
                        dir_fd,
                        config_name,
                        config_bytes,
                        record_bytes,
                    )
                    canonical_pair_contained = True
                except BaseException as containment_error:
                    rollback_errors.append(
                        "canonical pair fail-closed replacement: %s" % containment_error
                    )

            dir_clamped = False
            if dir_fd is not None:
                try:
                    clear_immutable(dir_fd)
                    os.fchown(dir_fd, os.geteuid(), os.getegid())
                    os.fchmod(dir_fd, 0o500)
                    os.fsync(dir_fd)
                    clamped_dir = os.fstat(dir_fd)
                    if (
                        clamped_dir.st_uid != os.geteuid()
                        or clamped_dir.st_gid != os.getegid()
                        or stat.S_IMODE(clamped_dir.st_mode) != 0o500
                    ):
                        die("config dir fail-closed clamp metadata mismatch")
                    dir_clamped = True
                except BaseException as clamp_error:
                    rollback_errors.append("config dir fail-closed clamp: %s" % clamp_error)

            if protect_parent:
                config_root_candidate = (
                    contain_on_error and canonical_pair_contained and dir_clamped
                )
                if config_root_candidate or (not contain_on_error and dir_clamped):
                    parent_gid = sandbox_gid
                    parent_mode = 0o1775
                else:
                    parent_gid = os.getegid()
                    parent_mode = 0o700

                parent_clamped = False
                try:
                    clear_immutable(parent_fd)
                    os.fchown(parent_fd, os.geteuid(), parent_gid)
                    os.fchmod(parent_fd, parent_mode)
                    os.fsync(parent_fd)
                    clamped_parent = os.fstat(parent_fd)
                    if (
                        clamped_parent.st_uid != os.geteuid()
                        or clamped_parent.st_gid != parent_gid
                        or stat.S_IMODE(clamped_parent.st_mode) != parent_mode
                    ):
                        die("config parent fail-closed clamp metadata mismatch")
                    parent_clamped = True
                except BaseException as clamp_error:
                    rollback_errors.append("config parent fail-closed clamp: %s" % clamp_error)

                if contain_on_error and parent_clamped:
                    containment_result = (
                        "config-root" if config_root_candidate else "sandbox-parent"
                    )
                elif contain_on_error and config_root_candidate:
                    try:
                        clear_immutable(parent_fd)
                        os.fchown(parent_fd, os.geteuid(), os.getegid())
                        os.fchmod(parent_fd, 0o700)
                        os.fsync(parent_fd)
                        clamped_parent = os.fstat(parent_fd)
                        if (
                            clamped_parent.st_uid != os.geteuid()
                            or clamped_parent.st_gid != os.getegid()
                            or stat.S_IMODE(clamped_parent.st_mode) != 0o700
                        ):
                            die("config parent fail-closed fallback metadata mismatch")
                        containment_result = "sandbox-parent"
                    except BaseException as clamp_error:
                        rollback_errors.append(
                            "config parent fail-closed fallback: %s" % clamp_error
                        )
    if dir_fd is not None:
        os.close(dir_fd)
    os.close(parent_fd)

if body_error is not None:
    status = "transaction-failed"
    if containment_attempted:
        status = containment_result
    elif rollback_errors:
        status = "rollback-failed"
    sys.stderr.write("%s:%s\n" % (ERROR_PROTOCOL_PREFIX, status))
    sys.stderr.flush()
    raise SystemExit(1)
print("hash-created" if hash_created else "hash-existing")
`;

export function buildDeepAgentsConfigLockCommand(
  configDir: string,
  configPath: string,
  failClosedOnError = false,
): string[] {
  return [
    "python3",
    "-I",
    "-c",
    DEEP_AGENTS_CONFIG_LOCK_NOFOLLOW_SCRIPT,
    configDir,
    configPath,
    ...(failClosedOnError ? ["--fail-closed-on-error"] : []),
  ];
}
