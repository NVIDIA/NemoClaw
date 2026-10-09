// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateName } from "../runner";
import { withMcpLifecycleLockSync } from "../state/mcp-lifecycle-lock-acquisition";
import { resolveAgentConfig, type AgentConfigTarget } from "./agent-config";
import { capturePrivilegedSandboxCommand } from "./privileged-exec";

export interface MutableHermesConfigVerification {
  readonly verified: boolean;
  readonly errors: readonly string[];
}

const MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS = 20_000;
const MUTABLE_HERMES_CONFIG_PROBE = String.raw`
import errno
import fcntl
import os
import stat
import struct
import subprocess
import sys

config_dir = os.path.normpath(sys.argv[1])
config_paths = [os.path.normpath(value) for value in sys.argv[2:]]
if not os.path.isabs(config_dir) or not config_paths:
    raise RuntimeError("Hermes mutable config probe requires absolute paths")

directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
file_flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW

def require_private_topology():
    result = subprocess.run(
        ["/opt/hermes/.venv/bin/python", "-I",
         "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
         "inspect-private-mutable-topology", "--hermes-dir", config_dir],
        capture_output=True, timeout=5, check=False,
    )
    if result.returncode != 0 or result.stdout != b"same-uid-nonroot\n":
        raise RuntimeError("Private Hermes config requires an attested same-UID runtime; rebuild with the current Hermes image")

def metadata(st):
    return (st.st_dev, st.st_ino, st.st_uid, st.st_gid, st.st_mode, st.st_nlink, st.st_ctime_ns)

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

directory_fd = os.open(config_dir, directory_flags)
try:
    directory = os.fstat(directory_fd)
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
    if metadata(os.stat(config_dir, follow_symlinks=False)) != metadata(directory):
        raise RuntimeError("Hermes config root changed during inspection")
finally:
    os.close(directory_fd)
`;

export function mutableHermesConfigProbeCommand(target: AgentConfigTarget): readonly string[] {
  if (target.agentName !== "hermes") {
    throw new Error(`agent ${target.agentName} does not use the mutable Hermes config contract`);
  }
  return [
    "/usr/bin/setpriv",
    "--reuid=sandbox",
    "--regid=sandbox",
    "--init-groups",
    "--",
    "/usr/bin/python3",
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
): MutableHermesConfigVerification {
  validateName(sandboxName, "sandbox name");
  return withMcpLifecycleLockSync(sandboxName, () => {
    const target = resolveAgentConfig(sandboxName);
    return verifyMutableHermesConfigForTarget(target, (command) => {
      capturePrivilegedSandboxCommand(sandboxName, command, {
        sanitizeEnvironment: true,
        timeout: MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS,
      });
    });
  });
}
