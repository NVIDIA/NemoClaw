// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { SandboxClient } from "./clients/sandbox.ts";
import { resultText } from "./clients/index.ts";
import type { ArtifactSink } from "./artifacts.ts";
import type { ShellProbeResult } from "./shell-probe.ts";
import { stripAnsi } from "../live/json-envelope.ts";
import { getNemoclawStateRoot } from "../../../src/lib/state/state-root.ts";

/** Preserve this install attempt's evidence before the fixture destroys its sandbox. */
export async function captureGpuInstallFailure(
  install: Pick<ShellProbeResult, "exitCode" | "stdout" | "stderr" | "startedAt" | "finishedAt">,
  sandbox: Pick<SandboxClient, "openshell">,
  artifacts: Pick<ArtifactSink, "writeJson" | "writeText">,
  environment: NodeJS.ProcessEnv,
  sandboxName: string,
): Promise<void> {
  if (install.exitCode === 0) return;
  const output = stripAnsi(resultText(install));
  const attempts = new Set(
    [...output.matchAll(/ai\.nvidia\.nemoclaw\.create-attempt=([a-f0-9]{62})(?![a-f0-9])/gu)].map(
      (match) => match[1],
    ),
  );
  if (attempts.size !== 1) return;
  const attempt = [...attempts][0];
  try {
    const root = path.join(getNemoclawStateRoot(environment.HOME), "onboard-failures");
    const directories = new Set(
      [...output.matchAll(/^\s*Diagnostics saved: (.+)$/gmu)].map((match) => match[1]),
    );
    const directory = directories.size === 1 ? [...directories][0] : undefined;
    const started = Date.parse(install.startedAt ?? "");
    const finished = Date.parse(install.finishedAt ?? "");
    if (directory && path.dirname(directory) === root) {
      const meta = fs.lstatSync(directory);
      const rootMeta = fs.lstatSync(root);
      const expectedSuffix = `-${sandboxName.slice(0, 80)}`;
      const timestamp = path.basename(directory).slice(0, -expectedSuffix.length);
      const emittedAt = Date.parse(
        timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u, "T$1:$2:$3.$4Z"),
      );
      if (
        meta.isDirectory() &&
        !meta.isSymbolicLink() &&
        rootMeta.isDirectory() &&
        !rootMeta.isSymbolicLink() &&
        rootMeta.uid === process.getuid?.() &&
        (rootMeta.mode & 0o077) === 0 &&
        fs.realpathSync(root) === root &&
        meta.uid === process.getuid?.() &&
        (meta.mode & 0o077) === 0 &&
        meta.birthtimeMs >= started &&
        meta.birthtimeMs <= finished &&
        emittedAt >= started &&
        emittedAt <= finished &&
        path.basename(directory).endsWith(expectedSuffix)
      ) {
        const file = path.join(directory, "sandbox-container.log");
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          const before = fs.fstatSync(fd);
          if (
            before.isFile() &&
            before.nlink === 1 &&
            before.uid === meta.uid &&
            (before.mode & 0o077) === 0 &&
            before.size <= 8192
          ) {
            // Read through the verified descriptor; accept output only after file and parent
            // metadata remain stable.
            const buffer = Buffer.alloc(8193);
            const length = fs.readSync(fd, buffer, {
              offset: 0,
              length: buffer.length,
              position: 0,
            });
            const after = fs.fstatSync(fd);
            const parents = [
              [root, rootMeta],
              [directory, meta],
            ] as const;
            const stableParents = parents.every(([name, expected]) => {
              const current = fs.lstatSync(name);
              return (
                current.isDirectory() &&
                current.dev === expected.dev &&
                current.ino === expected.ino &&
                current.uid === expected.uid &&
                current.mode === expected.mode &&
                current.ctimeMs === expected.ctimeMs
              );
            });
            if (
              stableParents &&
              length === before.size &&
              length <= 8192 &&
              before.size === after.size &&
              before.mtimeMs === after.mtimeMs &&
              before.ctimeMs === after.ctimeMs &&
              before.mode === after.mode &&
              before.nlink === after.nlink
            ) {
              await artifacts.writeText(
                "gpu-install-failure-container.log",
                buffer.subarray(0, length).toString("utf8"),
              );
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  } catch {
    // A missing or untrusted bundle must not replace the installer failure.
  }
  try {
    const observed = await sandbox.openshell(["sandbox", "get", sandboxName, "--output", "json"], {
      env: environment,
      timeoutMs: 15_000,
      captureLimitBytes: 64 * 1024,
      persistArtifacts: false,
    });
    if (observed.exitCode !== 0 || observed.timedOut || observed.signal !== null) return;
    const status = JSON.parse(observed.stdout);
    if (
      status.name !== sandboxName ||
      status.labels?.["ai.nvidia.nemoclaw.create-attempt"] !== attempt
    )
      return;
    const numeric = Object.fromEntries(
      ["exit_code", "restart_count", "main_process_started_at_ms", "next_restart_at_ms"]
        .filter((key) => Number.isSafeInteger(status[key]))
        .map((key) => [key, status[key]]),
    );
    const phase = [
      "Unspecified",
      "Provisioning",
      "Ready",
      "Error",
      "Deleting",
      "Stopping",
      "Stopped",
      "Starting",
      "Completed",
      "Unknown",
    ].includes(status.phase)
      ? status.phase
      : "unavailable";
    await artifacts.writeJson("gpu-install-failure-process.json", {
      attempt,
      phase,
      mainProcessObserved:
        typeof status.main_process_instance_id === "string" &&
        status.main_process_instance_id.length > 0,
      ...numeric,
    });
  } catch {
    // Raw status, policy, environment, and error strings are never artifact output.
  }
}
