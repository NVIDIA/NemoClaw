// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validateName } from "../runner";
import { withMcpLifecycleLockSync } from "../state/mcp-lifecycle-lock-acquisition";
import { resolveAgentConfig, type AgentConfigTarget } from "./agent-config";
import { verifyOpenClawConfigPosture } from "./openclaw-config-guard";
import {
  capturePrivilegedSandboxCommand,
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "./privileged-exec";

export interface MutableHermesConfigVerification {
  readonly verified: boolean;
  readonly errors: readonly string[];
}

export type MutableConfigPermsInspection =
  | { applies: false; skipReason: "agent" | "unavailable"; reason: string }
  | {
      applies: true;
      ok: boolean;
      issues: string[];
    };

export type MutableConfigRepairResult =
  | { applied: false; skipReason: "agent"; reason: string }
  | { applied: true; verified: boolean; errors: string[] };

const MUTABLE_CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS = 25_000;
const MUTABLE_CONFIG_NORMALIZER_WATCHDOG = [
  "/usr/bin/timeout",
  "--signal=TERM",
  "--kill-after=5s",
  "15s",
] as const;
const MUTABLE_HERMES_CONFIG_PROBE_TIMEOUT_MS = 20_000;
const MUTABLE_HERMES_CONFIG_PROBE = String.raw`
import os
import stat
import sys
import uuid

config_dir = os.path.normpath(sys.argv[1])
config_paths = [os.path.normpath(value) for value in sys.argv[2:]]
if not os.path.isabs(config_dir) or not config_paths:
    raise RuntimeError("Hermes mutable config probe requires absolute paths")

directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_DIRECTORY
file_flags = os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW
directory_fd = os.open(config_dir, directory_flags)
try:
    directory = os.fstat(directory_fd)
    if not stat.S_ISDIR(directory.st_mode):
        raise RuntimeError("Hermes config root is not a directory")
    if directory.st_uid != os.geteuid() or directory.st_gid != os.getegid():
        raise RuntimeError("Hermes config root is not owned by the sandbox identity")
    if stat.S_IMODE(directory.st_mode) != 0o3770:
        raise RuntimeError("Hermes config root does not have mode 3770")

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
        finally:
            os.close(descriptor)

    probe_name = ".nemoclaw-mutable-posture-" + uuid.uuid4().hex
    created = False
    try:
        os.mkdir(probe_name, 0o700, dir_fd=directory_fd)
        created = True
    finally:
        if created:
            os.rmdir(probe_name, dir_fd=directory_fd)
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

function sandboxIdentityId(sandboxName: string, flag: "-u" | "-g", resourceHandle: string): string {
  const id = capturePrivilegedSandboxCommand(sandboxName, ["/usr/bin/id", flag, "sandbox"], {
    sanitizeEnvironment: true,
    expectedResourceHandle: resourceHandle,
    timeout: 15_000,
  })
    .toString("utf8")
    .trim();
  if (!/^[1-9][0-9]*$/.test(id)) {
    throw new Error(`sandbox identity lookup returned an invalid ${flag === "-u" ? "UID" : "GID"}`);
  }
  return id;
}

function normalizeMutableOpenClawConfig(
  sandboxName: string,
  configDir: string,
  resourceHandle: string,
): void {
  const sandboxUid = sandboxIdentityId(sandboxName, "-u", resourceHandle);
  const sandboxGid = sandboxIdentityId(sandboxName, "-g", resourceHandle);
  capturePrivilegedSandboxCommand(
    sandboxName,
    [
      ...MUTABLE_CONFIG_NORMALIZER_WATCHDOG,
      "/usr/bin/python3",
      "-I",
      MUTABLE_CONFIG_NORMALIZER,
      configDir,
      sandboxUid,
      sandboxGid,
    ],
    {
      sanitizeEnvironment: true,
      expectedResourceHandle: resourceHandle,
      timeout: MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS,
    },
  );
}

function verifyOpenClawPosture(sandboxName: string, resourceHandle: string) {
  return verifyOpenClawConfigPosture({
    run(command) {
      const result = executePrivilegedSandboxCommand(sandboxName, command, {
        sanitizeEnvironment: true,
        expectedResourceHandle: resourceHandle,
        timeout: 35_000,
        maxOutputBytes: 32 * 1024,
      });
      return {
        ...result,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        error: result.error?.message,
      };
    },
  });
}

export function inspectMutableConfigPerms(sandboxName: string): MutableConfigPermsInspection {
  validateName(sandboxName, "sandbox name");
  return withMcpLifecycleLockSync(sandboxName, () => {
    const target = resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw") {
      return {
        applies: false,
        skipReason: "agent",
        reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
      };
    }
    try {
      const result = verifyOpenClawPosture(
        sandboxName,
        resolvePrivilegedSandboxTarget(sandboxName).resourceHandle,
      );
      if (result.issues.length > 0 && !result.repairable) {
        return { applies: false, skipReason: "unavailable", reason: result.issues.join("; ") };
      }
      return { applies: true, ok: result.issues.length === 0, issues: result.issues };
    } catch (error) {
      return {
        applies: false,
        skipReason: "unavailable",
        reason: `could not verify config posture (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  });
}

export function repairMutableConfigPerms(sandboxName: string): MutableConfigRepairResult {
  validateName(sandboxName, "sandbox name");
  return withMcpLifecycleLockSync(sandboxName, () => {
    const target = resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw") {
      return {
        applied: false,
        skipReason: "agent",
        reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
      };
    }
    try {
      const { resourceHandle } = resolvePrivilegedSandboxTarget(sandboxName);
      const before = verifyOpenClawPosture(sandboxName, resourceHandle);
      if (before.issues.length > 0) {
        if (!before.repairable) throw new Error(before.issues.join("; "));
        normalizeMutableOpenClawConfig(sandboxName, target.configDir, resourceHandle);
        const after = verifyOpenClawPosture(sandboxName, resourceHandle);
        if (after.issues.length > 0) throw new Error(after.issues.join("; "));
      }
      return { applied: true, verified: true, errors: [] };
    } catch (error) {
      return {
        applied: true,
        verified: false,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  });
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
