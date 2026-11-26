// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateName } from "../runner";
import { captureSanitizedResolvedOpenshell } from "../adapters/openshell/sanitized-capture";
import {
  resolveSandboxGatewayName,
  type SandboxGatewayBinding,
} from "../onboard/gateway-binding/identity";
import { withMcpLifecycleLockSync } from "../state/mcp-lifecycle-lock-acquisition";
import { renderTerminalText } from "../policy/preset-scope-render";
import { resolveAgentConfig, type AgentConfigTarget } from "./agent-config";

export interface MutableHermesConfigVerification {
  readonly verified: boolean;
  readonly errors: readonly string[];
}

const MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS = 35_000;
const MUTABLE_HERMES_CONFIG_PROBE = String.raw`
import errno
import fcntl
import os
import pwd
import runpy
import signal
import stat
import struct
import sys

sandbox_identity = pwd.getpwnam("sandbox")
if (os.geteuid() == 0 or os.geteuid() != sandbox_identity.pw_uid or
        os.getegid() != sandbox_identity.pw_gid):
    raise RuntimeError("Hermes config probe requires the non-root sandbox identity")

config_dir = os.path.normpath(sys.argv[1])
config_paths = [os.path.normpath(value) for value in sys.argv[2:]]
if not os.path.isabs(config_dir) or not config_paths:
    raise RuntimeError("Hermes mutable config probe requires absolute paths")

# Health can precede the supervisor's final startup writes. Wait before taking
# the integrity snapshot; never retry an inspection that observes a mutation.
startup_helper = "/usr/local/lib/nemoclaw/hermes-startup-completion.py"
try:
    startup = runpy.run_path(startup_helper)
except FileNotFoundError as error:
    if error.filename != startup_helper:
        raise
    # Retained/custom images predate the scheduling helper. Their existing
    # integrity contract remains required, without a startup-completion claim.
    startup = None
if startup is not None and not startup["requires_completion"]():
    # The root-separated entrypoint retains its existing startup protocol.
    startup = None
startup_receipt = startup["wait_for_completion"]() if startup is not None else None

directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
file_flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW

# Load the existing checker before the integrity snapshot. Starting another
# interpreter inside each check lets background runtime writes overlap imports.
private_topology = None
if stat.S_IMODE(os.stat(config_dir, follow_symlinks=False).st_mode) == 0o700:
    private_topology = runpy.run_path(
        "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
    )["inspect_private_mutable_topology"]

class TopologyDeadline(BaseException):
    pass

def topology_deadline(_signal, _frame):
    raise TopologyDeadline("Hermes topology inspection timed out")

def require_private_topology():
    previous_handler = signal.signal(signal.SIGALRM, topology_deadline)
    signal.alarm(5)
    try:
        if private_topology is None:
            raise RuntimeError("Hermes config root changed before inspection")
        private_topology()
    except (Exception, TopologyDeadline) as error:
        raise RuntimeError("Private Hermes config requires an attested same-UID runtime; rebuild with the current Hermes image") from error
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)

metadata_fields = ("st_dev", "st_ino", "st_uid", "st_gid", "st_mode", "st_nlink", "st_ctime_ns")

def metadata(st):
    return tuple(getattr(st, name) for name in metadata_fields)

def require_mutable_flags(descriptor, info):
    if hasattr(info, "st_flags"):
        flags = info.st_flags
        blocked = stat.UF_IMMUTABLE | stat.UF_APPEND | stat.SF_IMMUTABLE | stat.SF_APPEND
    else:
        try:
            flags = struct.unpack("I", fcntl.ioctl(descriptor, 0x80086601, struct.pack("I", 0)))[0]
        except OSError as exc:
            # Match the runtime guard on filesystems without inode-flag support.
            if exc.errno in (errno.ENOTTY, errno.EOPNOTSUPP, errno.EINVAL):
                return
            raise
        blocked = 0x10 | 0x20
    if flags & blocked:
        raise PermissionError("Hermes config has immutable or append-only inode flags")

# Metadata only for fixed runtime-state entries; never follow their targets.
known_runtime_names = ("gateway_state.json", "shared-state.db", "shared-state.db-wal", "shared-state.db-shm")

def known_runtime_state():
    snapshot = {}
    for name in known_runtime_names:
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            snapshot[name] = ("present", info.st_dev, info.st_ino, info.st_mode,
                              info.st_nlink, info.st_ctime_ns, info.st_mtime_ns)
        except FileNotFoundError:
            snapshot[name] = ("absent",)
        except OSError:
            snapshot[name] = ("unavailable",)
    return snapshot

def known_runtime_changes(initial):
    current = known_runtime_state()
    changes = []
    for name in known_runtime_names:
        before, after = initial[name], current[name]
        if "unavailable" in (before[0], after[0]):
            change = "unavailable"
        elif before == after:
            continue
        elif before[0] == "absent":
            change = "created"
        elif after[0] == "absent":
            change = "removed"
        elif before[1:3] != after[1:3]:
            change = "replaced"
        else:
            change = "metadata-changed"
        changes.append(name + "=" + change)
    return ", ".join(changes) if changes else "none observed"

directory_fd = os.open(config_dir, directory_flags)
try:
    directory = os.fstat(directory_fd)
    initial_known_runtime_state = known_runtime_state()
    if not stat.S_ISDIR(directory.st_mode):
        raise RuntimeError("Hermes config root is not a directory")
    if directory.st_uid != os.geteuid() or directory.st_gid != os.getegid():
        raise RuntimeError("Hermes config root is not owned by the sandbox identity")
    private_root = stat.S_IMODE(directory.st_mode) == 0o700
    if private_root:
        require_private_topology()
    elif stat.S_IMODE(directory.st_mode) != 0o3770:
        raise RuntimeError("Hermes config root does not have an allowed mutable mode")
    require_mutable_flags(directory_fd, directory)
    if not os.access(".", os.W_OK | os.X_OK, dir_fd=directory_fd, effective_ids=True):
        raise PermissionError("Hermes config root is not writable by the sandbox identity")

    for config_path in config_paths:
        if os.path.dirname(config_path) != config_dir:
            raise RuntimeError("Hermes config artifact escaped the config root")
        descriptor = os.open(os.path.basename(config_path), file_flags, dir_fd=directory_fd)
        try:
            artifact = os.fstat(descriptor)
            if not stat.S_ISREG(artifact.st_mode) or artifact.st_nlink != 1:
                raise RuntimeError("Hermes config artifact is not a singly linked regular file")
            if artifact.st_uid != os.geteuid() or artifact.st_gid != os.getegid():
                raise RuntimeError("Hermes config artifact is not owned by the sandbox identity")
            if stat.S_IMODE(artifact.st_mode) != 0o640:
                raise RuntimeError("Hermes config artifact does not have mode 0640")
            require_mutable_flags(descriptor, artifact)
            if not os.access(os.path.basename(config_path), os.W_OK, dir_fd=directory_fd,
                             effective_ids=True, follow_symlinks=False):
                raise PermissionError("Hermes config artifact is not writable by the sandbox identity")
            if metadata(os.stat(os.path.basename(config_path), dir_fd=directory_fd,
                                follow_symlinks=False)) != metadata(artifact):
                raise RuntimeError("Hermes config artifact changed during inspection")
        finally:
            os.close(descriptor)

    if private_root:
        require_private_topology()
    current_directory_info = os.stat(config_dir, follow_symlinks=False)
    current_directory = metadata(current_directory_info)
    initial_directory = metadata(directory)
    if current_directory != initial_directory:
        changed_fields = [name for name, before, after in
                          zip(metadata_fields, initial_directory, current_directory)
                          if before != after]
        # Report timestamp and fixed-entry metadata comparisons without state contents.
        # These observations do not identify the writer or permit another inspection.
        mtime_change = "changed" if current_directory_info.st_mtime_ns != directory.st_mtime_ns else "unchanged"
        raise RuntimeError("Hermes config root changed during inspection: " + ", ".join(changed_fields)
                           + "; directory mtime " + mtime_change
                           + "; known entries in inspected directory: "
                           + known_runtime_changes(initial_known_runtime_state))
    if startup is not None and startup["read_completion"]() != startup_receipt:
        raise RuntimeError("Hermes startup generation changed during config inspection")
finally:
    os.close(directory_fd)
`;

export function mutableHermesConfigProbeCommand(target: AgentConfigTarget): readonly string[] {
  if (target.agentName !== "hermes") {
    throw new Error(`agent ${target.agentName} does not use the mutable Hermes config contract`);
  }
  return [
    "/opt/hermes/.venv/bin/python3",
    "-I",
    "-c",
    MUTABLE_HERMES_CONFIG_PROBE,
    target.configDir,
    target.configPath,
    ...(target.sensitiveFiles ?? []),
  ];
}

export function verifyMutableHermesConfigForTarget(
  target: AgentConfigTarget,
  executeProbe: (command: readonly string[]) => void,
): MutableHermesConfigVerification {
  try {
    executeProbe(mutableHermesConfigProbeCommand(target));
    return { verified: true, errors: [] };
  } catch (error) {
    return {
      verified: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function inspectMutableHermesConfigPerms(
  sandboxName: string,
  getSandbox: (name: string) => SandboxGatewayBinding | null,
): MutableHermesConfigVerification {
  validateName(sandboxName, "sandbox name");
  return withMcpLifecycleLockSync(sandboxName, () => {
    const target = resolveAgentConfig(sandboxName);
    return verifyMutableHermesConfigForTarget(target, (command) => {
      const sandbox = getSandbox(sandboxName);
      if (!sandbox) throw new Error("Hermes config probe requires a registered sandbox");
      const result = captureSanitizedResolvedOpenshell(
        [
          "sandbox",
          "exec",
          "--name",
          sandboxName,
          "-g",
          resolveSandboxGatewayName(sandbox),
          "--no-tty",
          "--no-login-shell",
          "--timeout",
          "30",
          "--",
          ...command,
        ],
        {
          ignoreError: true,
          includeStderr: true,
          includeStreams: true,
          maxBuffer: 64 * 1024,
          timeout: MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS,
        },
      );
      if (result.error || result.signal || result.status !== 0) {
        const detail = [
          result.error?.message ?? result.signal ?? `exit ${result.status}`,
          result.stderr,
        ]
          .filter(Boolean)
          .join(": ");
        throw new Error(
          `Hermes config probe failed (${renderTerminalText(detail.trim()).slice(-4096)})`,
        );
      }
    });
  });
}
