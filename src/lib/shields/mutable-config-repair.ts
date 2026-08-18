// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const dockerExec: typeof import("../adapters/docker/exec") = require("../adapters/docker/exec");
const privilegedExecModule: typeof import("../sandbox/privileged-exec") = require("../sandbox/privileged-exec");

const MUTABLE_CONFIG_NORMALIZER = "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py";
const MUTABLE_CONFIG_NORMALIZER_FAILURE_PREFIX = "NEMOCLAW_MUTABLE_CONFIG_NORMALIZER_FAILURE:";
const MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS = 25000;
const MUTABLE_CONFIG_NORMALIZER_WATCHDOG = [
  "/usr/bin/timeout",
  "--signal=TERM",
  "--kill-after=5s",
  "15s",
] as const;

const FIXED_FILE_FAILURES = new Map([
  ["read", "metadata access"],
  ["type", "file-type"],
  ["filesystem", "filesystem"],
  ["owner", "ownership"],
  ["mode", "mode"],
  ["link", "link-count"],
  ["identity", "inode-identity"],
]);
const FIXED_FILE_LABELS = new Map([
  ["openclaw-config", "OpenClaw configuration"],
  ["config-hash", "configuration hash"],
]);
const NORMALIZER_FAILURE_STAGES = new Map([
  ["config-directory-validation", "configuration directory validation"],
  ["fixed-file-validation", "fixed-file validation"],
  ["tree-walk", "mutable configuration tree traversal"],
  ["config-recovery", "configuration recovery"],
  ["recovery-baseline-validation", "recovery baseline validation"],
  ["final-binding-validation", "final path binding validation"],
  ["privilege-transition", "sandbox identity transition"],
  ["mutable-config-validation", "mutable configuration validation"],
  ["descriptor-handoff", "directory descriptor handoff"],
]);

type ProcessFailure = {
  code?: unknown;
  signal?: unknown;
  status?: unknown;
  stderr?: unknown;
};

function processFailure(error: unknown): ProcessFailure | null {
  return typeof error === "object" && error !== null ? (error as ProcessFailure) : null;
}

function failureStderr(error: ProcessFailure | null): string {
  if (typeof error?.stderr === "string") return error.stderr;
  return Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : "";
}

function normalizerFailureStage(error: ProcessFailure | null): string | null {
  const marker = failureStderr(error)
    .split(/\r?\n/u)
    .find((line) => line.startsWith(MUTABLE_CONFIG_NORMALIZER_FAILURE_PREFIX));
  if (!marker) return null;
  const reason = marker.slice(MUTABLE_CONFIG_NORMALIZER_FAILURE_PREFIX.length);
  const fixedMatch = /^fixed-file-([a-z]+):(openclaw-config|config-hash)$/u.exec(reason);
  if (fixedMatch) {
    const failure = FIXED_FILE_FAILURES.get(fixedMatch[1] ?? "");
    const file = FIXED_FILE_LABELS.get(fixedMatch[2] ?? "");
    return failure && file ? `${file} ${failure} validation` : null;
  }
  return NORMALIZER_FAILURE_STAGES.get(reason) ?? null;
}

function classifiedNormalizerError(error: unknown): Error {
  const failure = processFailure(error);
  if (failure?.code === "ETIMEDOUT") {
    return new Error("Mutable OpenClaw configuration repair failed: host command timed out");
  }
  if (failure?.status === 124) {
    return new Error(
      "Mutable OpenClaw configuration repair failed: 15-second helper watchdog timed out",
    );
  }
  if (failure?.status === 137) {
    return new Error(
      "Mutable OpenClaw configuration repair failed: in-sandbox watchdog exited with status 137",
    );
  }
  if (typeof failure?.signal === "string" && failure.signal.length > 0) {
    return new Error(
      "Mutable OpenClaw configuration repair failed: host Docker command was terminated by a signal",
    );
  }
  const stage = normalizerFailureStage(failure);
  if (failure?.status === 1 && stage !== null) {
    return new Error(`Mutable OpenClaw configuration repair failed: ${stage} failed`);
  }
  if (failure?.status === 1) {
    return new Error(
      "Mutable OpenClaw configuration repair failed: Docker repair command exited without a trusted helper diagnostic",
    );
  }
  return new Error("Mutable OpenClaw configuration repair failed: Docker repair command failed");
}

function runPrivileged(sandboxName: string, cmd: string[], timeout = 15000): void {
  privilegedExecModule.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "mutable config permission repair",
    () => {
      const argv = privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true);
      try {
        dockerExec.dockerExecFileSync(argv, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        });
      } catch (error) {
        // The Docker error can contain command output or mutable paths. Report
        // only the helper's fixed reason labels and execution outcome.
        throw classifiedNormalizerError(error);
      }
    },
  );
}

function privilegedExecCapture(sandboxName: string, cmd: string[], timeout = 15000): string {
  return privilegedExecModule.withPrivilegedSandboxExecutionLease(
    sandboxName,
    "mutable config identity lookup",
    () =>
      dockerExec
        .dockerExecFileSync(
          privilegedExecModule.privilegedSandboxExecArgv(sandboxName, cmd, false, true),
          {
            stdio: ["ignore", "pipe", "pipe"],
            timeout,
          },
        )
        .trim(),
  );
}

function sandboxIdentityId(sandboxName: string, flag: "-u" | "-g"): string {
  const id = privilegedExecCapture(sandboxName, ["/usr/bin/id", flag, "sandbox"]);
  // Keep the ownership target non-root so privileged repair cannot become a
  // confused-deputy path.
  if (!/^[1-9][0-9]*$/.test(id)) {
    const kind = flag === "-u" ? "UID" : "GID";
    throw new Error(`sandbox identity lookup returned an invalid ${kind}`);
  }
  return id;
}

/** Apply the mutable OpenClaw contract through the image's trusted helper. */
export function normalizeMutableOpenClawConfig(sandboxName: string, configDir: string): void {
  const sandboxUid = sandboxIdentityId(sandboxName, "-u");
  const sandboxGid = sandboxIdentityId(sandboxName, "-g");
  // The in-sandbox watchdog signals the Python process group and reaps its
  // direct child before the longer host-side Docker timeout can release the
  // shields transition lock.
  runPrivileged(
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
    MUTABLE_CONFIG_NORMALIZER_HOST_TIMEOUT_MS,
  );
}
