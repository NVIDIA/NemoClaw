# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Observe the installed routing contract without sending a model request.

This proves expected startup inputs, not activation in the gateway. Native
validation runs in this short-lived process and releases its activation before
returning. The existing judge qualifier owns the separate live request.
"""

import contextlib
import fcntl
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import pwd
import signal
import shlex
import stat
import subprocess
import sys
import tempfile
import tomllib

ROOT_UID = 0
DIRECTORY = Path("/usr/local/share/nemoclaw")
PATHS = {
    "relayPluginsToml": DIRECTORY / "hermes-relay-plugins.toml",
    "relayPluginStateJson": DIRECTORY / ".dynamic-plugins.json",
    "switchyardDeploymentToml": DIRECTORY / "hermes-switchyard-v1.toml",
}
LOCK_PATH = DIRECTORY / "hermes-switchyard.lock"
EXPECTED_ENV = "NEMOCLAW_HERMES_SWITCHYARD_SHA256"
PLUGINS_ENV = "HERMES_NEMO_RELAY_PLUGINS_TOML"
PACKAGE = Path("/opt/nemo-relay/plugins/switchyard")
HELPERS = Path("/opt/nemoclaw-hermes-config")
GUARD = Path("/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py")
BOUNDARY = Path("/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py")
MAX_CONFIG_BYTES = 128 * 1024


def load_helper(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def protected_parent(path):
    """Pin every parent descriptor, refusing symlinks and non-root writers."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in Path(path).parent.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            metadata = os.fstat(fd)
            if metadata.st_uid not in (0, ROOT_UID) or metadata.st_mode & 0o022:
                raise ValueError("unprotected parent")
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_protected(path, limit=MAX_CONFIG_BYTES):
    parent = protected_parent(path)
    try:
        fd = os.open(Path(path).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != ROOT_UID
                    or before.st_mode & 0o022 or before.st_nlink != 1
                    or not 0 < before.st_size <= limit):
                raise ValueError("unprotected file")
            with os.fdopen(os.dup(fd), "rb") as source:
                data = source.read(limit + 1)
            after = os.fstat(fd)
            fields = ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink",
                      "st_size", "st_mtime_ns", "st_ctime_ns")
            if any(getattr(before, key) != getattr(after, key) for key in fields) or len(data) != before.st_size:
                raise ValueError("file changed")
            return data
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def fingerprint(files):
    return hashlib.sha256(b"\0".join(files[key].encode() for key in PATHS)).hexdigest()


def read_installed(expected=None):
    files = {key: read_protected(path).decode("utf-8") for key, path in PATHS.items()}
    if expected is not None and files != expected:
        raise ValueError("configuration drift")
    return files


def package_identity():
    installer = load_helper("switchyard_installer", HELPERS / "install-switchyard.py")
    versions = tuple(importlib.metadata.version(name) for name in ("hermes-agent", "nemo-relay"))
    if versions != ("0.21.3", "0.8.3"):
        raise ValueError("unreviewed versions")
    release = installer.RELEASES[platform.machine()]
    files = {name: read_protected(PACKAGE / name, 64 * 1024 * 1024)
             for name in ("relay-plugin.toml", "config.schema.json", installer.LIBRARY)}
    installer.validate_bundle(files, release)
    return hashlib.sha256(b"\0".join(files.values()) + repr(versions).encode()).hexdigest()


@contextlib.contextmanager
def silence_native_output():
    """Native diagnostics can contain input values; expose only our categories."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved = [os.dup(fd) for fd in (1, 2)]
    with open(os.devnull, "w") as sink:
        try:
            for fd in (1, 2):
                os.dup2(sink.fileno(), fd)
            yield
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            for fd, original in zip((1, 2), saved):
                os.dup2(original, fd)
                os.close(original)


def validate_native(activation_path, *, runtime_factory=None, relay=None):
    previous = os.environ.get(PLUGINS_ENV)
    os.environ[PLUGINS_ENV] = str(activation_path)
    runtime = None
    try:
        with silence_native_output():
            if runtime_factory is None:
                from agent.relay_runtime import RelayRuntime
                import nemo_relay
                runtime_factory, relay = RelayRuntime, nemo_relay
            baseline = sorted(relay.plugin.list_kinds())
            runtime = runtime_factory()
            try:
                if not runtime.managed_execution_enabled():
                    raise ValueError("native validation rejected")
            finally:
                runtime.shutdown()
            if relay.plugin.report() is not None or sorted(relay.plugin.list_kinds()) != baseline:
                raise ValueError("native activation remained after shutdown")
    finally:
        if previous is None:
            os.environ.pop(PLUGINS_ENV, None)
        else:
            os.environ[PLUGINS_ENV] = previous


def credential_keys(files):
    deployment = tomllib.loads(files["switchyardDeploymentToml"])
    return sorted({client["api_key_env"] for client in deployment["llm_clients"].values()})


def verify_placeholders(files, environment):
    guard = load_helper("switchyard_runtime_guard", GUARD)
    boundary = load_helper("switchyard_secret_boundary", BOUNDARY)
    with boundary._open_env_path("/sandbox/.hermes/.env") as (fd, identity, parents, chain, name):
        text = boundary._read_bounded_env(fd, identity).decode("utf-8")
        boundary._verify_env_path_chain(fd, identity, parents[-1], chain, name)
    references = {}
    for key in credential_keys(files):
        value = environment.get(key, "")
        transport_placeholder = boundary.PLACEHOLDER_RE.fullmatch(value)
        if not (guard._provider_placeholder_for_env_key(value, key) or (
                transport_placeholder and guard._placeholder_suffix_matches_env_key(
                    value.split("OPENSHELL-RESOLVE-ENV-", 1)[1], key))):
            raise ValueError("credential reference unavailable")
        assignments = [boundary.unquote(parsed[2]) for line in text.splitlines()
                       if (parsed := guard._parse_env_assignment(line)) is not None and parsed[1] == key]
        if len(assignments) > 1 or (assignments and assignments[0] != value):
            raise ValueError("credential file differs from startup reference")
        references[key] = hashlib.sha256(json.dumps([value, assignments]).encode()).hexdigest()
    return references


def gateway_identity():
    os.environ["HERMES_HOME"] = "/sandbox/.hermes"
    from gateway import status
    payload = status.read_runtime_status()
    if not isinstance(payload, dict):
        raise ValueError("gateway identity unavailable")
    pid, start = payload.get("pid"), payload.get("start_time")
    if (type(pid) is not int or pid <= 0 or type(start) is not int or start < 0
            or status.get_runtime_status_running_pid(
                runtime=payload, expected_home=Path("/sandbox/.hermes")) != pid
            or gateway_pids() != {pid}):
        raise ValueError("gateway identity ambiguous")
    return {"pid": pid, "startTime": start}


def gateway_pids():
    """Use Hermes's command grammar, but never treat a failed scan as stopped."""
    from gateway.status import looks_like_gateway_command_line
    pids = set()
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            with (process / "cmdline").open("rb") as source:
                raw = source.read(1024 * 1024 + 1)
        except FileNotFoundError:
            continue
        if len(raw) > 1024 * 1024:
            raise ValueError("process command exceeds bound")
        argv = [value.decode() for value in raw.split(b"\0") if value]
        if looks_like_gateway_command_line(shlex.join(argv)):
            pids.add(int(process.name))
    return pids


def inspect(expected):
    package = package_identity()
    files = read_installed(expected)
    identity = gateway_identity()
    # Only credential reference names and the expected-input fingerprint leave
    # this observer. Never return the gateway's environment or provider values.
    inputs = read_gateway_inputs(identity["pid"], files)
    environment = inputs["environment"]
    expected_hash = fingerprint(files)
    if environment.get(EXPECTED_ENV) != expected_hash:
        raise ValueError("startup configuration identity missing")
    references = inputs["credentialReferences"]
    for key in credential_keys(files):
        os.environ[key] = environment[key]
    validate_native(PATHS["relayPluginsToml"])
    if (gateway_identity() != identity or read_installed(expected) != files
            or package_identity() != package or read_gateway_inputs(identity["pid"], files) != inputs):
        raise ValueError("observation changed")
    return {"version": 1, "configuration": expected_hash, "package": package,
            "gateway": identity, "credentialReferences": references}


def gateway_inputs(pid, files):
    with open(f"/proc/{pid}/environ", "rb") as source:
        raw = source.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("environment exceeds bound")
    environment = dict(item.decode().split("=", 1) for item in raw.split(b"\0") if b"=" in item)
    references = verify_placeholders(files, environment)
    if environment.get(EXPECTED_ENV) != fingerprint(files):
        raise ValueError("startup configuration identity missing")
    return {"environment": {key: environment[key] for key in credential_keys(files) + [EXPECTED_ENV]},
            "credentialReferences": references}


def read_gateway_inputs(pid, files):
    # /proc/environ uses ptrace permissions, not ordinary root file access.
    # Read only the requested references in a bounded child under the process
    # UID; the managed image deliberately does not grant CAP_SYS_PTRACE.
    owner = os.stat(f"/proc/{pid}")
    account = pwd.getpwuid(owner.st_uid)
    result = subprocess.run([
        sys.executable, "-I", "-c",
        "import json,runpy,sys; "
        "module=runpy.run_path('/opt/nemoclaw-hermes-config/switchyard-preflight.py'); "
        "print(json.dumps(module['gateway_inputs'](int(sys.argv[1]), json.load(sys.stdin))))",
        str(pid),
    ], input=json.dumps(files).encode(), user=owner.st_uid, group=owner.st_gid,
        extra_groups=os.getgrouplist(account.pw_name, owner.st_gid), env={},
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
    if len(result.stdout) > MAX_CONFIG_BYTES:
        raise ValueError("credential references exceed bound")
    return json.loads(result.stdout)


@contextlib.contextmanager
def publication_lock():
    parent = protected_parent(LOCK_PATH)
    try:
        try:
            fd = os.open(LOCK_PATH.name,
                         os.O_RDONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o444, dir_fd=parent)
        except FileExistsError:
            fd = os.open(LOCK_PATH.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=parent)
        else:
            os.fchmod(fd, 0o444)
        try:
            metadata = os.fstat(fd)
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != ROOT_UID
                    or stat.S_IMODE(metadata.st_mode) != 0o444 or metadata.st_nlink != 1):
                raise ValueError("unprotected lock")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def publish(files):
    if os.geteuid() != ROOT_UID:
        raise ValueError("publication requires root")
    if files is None and not any(path.exists() or path.is_symlink() for path in PATHS.values()):
        return
    with publication_lock():
        if gateway_pids():
            raise ValueError("gateway must be stopped")
        if files is None:
            for path in PATHS.values():
                if path.exists() or path.is_symlink():
                    read_protected(path)
                    path.unlink()
            return
        if set(files) != set(PATHS) or any(
                not isinstance(value, str) or not 0 < len(value.encode()) <= MAX_CONFIG_BYTES
                for value in files.values()):
            raise ValueError("invalid publication input")
        if any(path.exists() or path.is_symlink() for path in PATHS.values()):
            # Interrupted publication or unexpected old inputs are not an
            # instruction to repair. A complete exact replay is read-only.
            read_installed(files)
            return
        package_identity()
        # Validate all proposed inputs together before touching the live names.
        # Only the native deployment path changes in this private staging copy.
        with tempfile.TemporaryDirectory(prefix=".switchyard-", dir=DIRECTORY) as temporary:
            staged = Path(temporary)
            deployment = staged / "deployment.toml"
            deployment.write_text(files["switchyardDeploymentToml"])
            activation = staged / "plugins.toml"
            activation.write_text(files["relayPluginsToml"].replace(
                str(PATHS["switchyardDeploymentToml"]), str(deployment)))
            json.loads(files["relayPluginStateJson"])
            # Native initialization resolves credential references but does not
            # use them. Root publication never receives provider credentials.
            for key in credential_keys(files):
                os.environ[key] = "nemoclaw-request-free-validation"
            validate_native(activation)
            for key in ("switchyardDeploymentToml", "relayPluginStateJson", "relayPluginsToml"):
                source = staged / key
                with source.open("xb") as output:
                    output.write(files[key].encode())
                    output.flush()
                    os.fchmod(output.fileno(), 0o444)
                    os.fsync(output.fileno())
                os.replace(source, PATHS[key])
            directory = os.open(DIRECTORY, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        read_installed(files)


def startup():
    package_identity()
    files = read_installed()
    if os.environ.get(EXPECTED_ENV) != fingerprint(files):
        raise ValueError("expected startup identity missing or changed")
    verify_placeholders(files, os.environ)
    validate_native(PATHS["relayPluginsToml"])


def main():
    signal.alarm(45)
    category = "unavailable"
    try:
        operation = sys.argv[1]
        category = "publication" if operation == "publish" else "preflight"
        data = sys.stdin.buffer.read(3 * MAX_CONFIG_BYTES + 1)
        if len(data) > 3 * MAX_CONFIG_BYTES:
            raise ValueError("input exceeds bound")
        expected = json.loads(data)
        with silence_native_output():
            result = publish(expected) if operation == "publish" else inspect(expected)
        print(json.dumps({"ok": True, "evidence": result}, separators=(",", ":")))
        return 0
    except Exception:
        print(json.dumps({"ok": False, "category": category}, separators=(",", ":")))
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
