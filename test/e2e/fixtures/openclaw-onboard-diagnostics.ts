// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "./clients/sandbox.ts";
import type { ShellProbeResult } from "./shell-probe.ts";
import { captureOpenClawContainerFailure } from "./openclaw-container-diagnostics.ts";

const LOG_PATHS = ["/tmp/nemoclaw-start.log", "/tmp/gateway.log", "/tmp/auto-pair.log"];

export function buildOpenClawOnboardDiagnosticsCommand(
  paths: readonly string[] = LOG_PATHS,
): string[] {
  return [
    "node",
    "-e",
    String.raw`
const fs = require("node:fs");
for (const file of process.argv.slice(1)) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe log");
    // Do not split a credential before the host applies value redaction.
    if (stat.size > 16384) {
      console.log(JSON.stringify({ file, uid: stat.uid, gid: stat.gid, mode: stat.mode & 511,
        size: stat.size, logOmitted: "size-limit" }));
      continue;
    }
    const buffer = Buffer.alloc(stat.size);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    if (bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      console.log(JSON.stringify({ file, logOmitted: "changed-during-read" }));
      continue;
    }
    console.log(JSON.stringify({ file, uid: stat.uid, gid: stat.gid, mode: stat.mode & 511,
      truncated: false, log: buffer.subarray(0, bytes).toString("utf8") }));
  } catch {
    console.log(JSON.stringify({ file, readable: false }));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
for (const file of ["/sandbox/.openclaw", "/sandbox/.openclaw/openclaw.json"]) {
  try {
    const stat = fs.lstatSync(file);
    console.log(JSON.stringify({ file, uid: stat.uid, gid: stat.gid, mode: stat.mode & 4095,
      symlink: stat.isSymbolicLink(), size: stat.size }));
  } catch { console.log(JSON.stringify({ file, readable: false })); }
}
`,
    ...paths,
  ];
}

/** Capture evidence before fixture cleanup without replacing the install result. */
export async function captureOpenClawOnboardFailure(
  install: Pick<ShellProbeResult, "exitCode">,
  sandbox: Pick<SandboxClient, "openshell" | "exec">,
  options: {
    sandboxName: string;
    artifactPrefix: string;
    env: NodeJS.ProcessEnv;
    redactionValues: readonly string[];
    runtime?: Parameters<typeof captureOpenClawContainerFailure>[0];
  },
): Promise<void> {
  if (install.exitCode === 0) return;
  const probeOptions = {
    env: options.env,
    // The log reader serializes text as JSON; protect both representations.
    redactionValues: [
      ...new Set(
        options.redactionValues.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
      ),
    ],
    timeoutMs: 15_000,
    killGraceMs: 1_000,
    captureLimitBytes: 64 * 1024,
  };
  await Promise.allSettled([
    ...(options.runtime
      ? [
          captureOpenClawContainerFailure(
            options.runtime,
            options.sandboxName,
            options.artifactPrefix,
            probeOptions,
            buildOpenClawOnboardDiagnosticsCommand(),
          ),
        ]
      : []),
    Promise.resolve().then(() =>
      sandbox.openshell(["sandbox", "get", options.sandboxName], {
        ...probeOptions,
        artifactName: `${options.artifactPrefix}-failure-status`,
      }),
    ),
    Promise.resolve().then(() =>
      sandbox.openshell(["logs", options.sandboxName, "-n", "120", "--source", "all"], {
        ...probeOptions,
        artifactName: `${options.artifactPrefix}-failure-openshell-logs`,
      }),
    ),
    Promise.resolve().then(() =>
      sandbox.exec(options.sandboxName, buildOpenClawOnboardDiagnosticsCommand(), {
        ...probeOptions,
        artifactName: `${options.artifactPrefix}-failure-startup-logs`,
      }),
    ),
    Promise.resolve().then(() =>
      sandbox.exec(
        options.sandboxName,
        [
          "curl",
          "--noproxy",
          "*",
          "--max-time",
          "3",
          "-sS",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://127.0.0.1:18789/healthz",
        ],
        { ...probeOptions, artifactName: `${options.artifactPrefix}-failure-health` },
      ),
    ),
  ]);
}
