// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "./artifacts.ts";
import { spawnObservedChild } from "./observed-child-process.ts";
import type { TestProgress } from "./progress.ts";

const BUILD_TIMEOUT_MS = 20 * 60_000;
const DIAGNOSTIC_TAIL_CHARS = 8_192;
const SAFE_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM", "ETIMEDOUT"]);
type BuildResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  diagnostic: string;
  error?: Error;
};

type BuildRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
) => Promise<BuildResult>;

function runPodmanBuild(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  progress: TestProgress,
): Promise<BuildResult> {
  let child: ReturnType<typeof spawnObservedChild>;
  try {
    child = spawnObservedChild("podman", args, {
      activityLabel: "command: portable-sandbox-image-build",
      progress,
      spawn: { env, stdio: ["ignore", "pipe", "pipe"], shell: false },
    });
  } catch (cause) {
    return Promise.resolve({
      status: null,
      signal: null,
      diagnostic: "",
      error: cause instanceof Error ? cause : new Error("Podman build could not start"),
    });
  }
  return new Promise((resolve) => {
    let diagnostic = "";
    let error: Error | undefined;
    let timedOut = false;
    const appendDiagnostic = (chunk: Buffer) => {
      // Dockerfile steps can print credentials. Keep only a bounded in-memory tail.
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(-DIAGNOSTIC_TAIL_CHARS);
    };
    child.stdout?.on("data", appendDiagnostic);
    child.stderr?.on("data", appendDiagnostic);
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (cause) => {
      error = cause;
    });
    child.once("close", (status, signal) => {
      clearTimeout(deadline);
      resolve({
        status,
        signal,
        diagnostic,
        error: timedOut
          ? Object.assign(new Error("Podman build timed out"), { code: "ETIMEDOUT" })
          : error,
      });
    });
  });
}

function failureCategory(output: string): string {
  const diagnostic = output.slice(-8_192).toLowerCase();
  if (/no space left on device|enospc/u.test(diagnostic)) return "disk-full";
  if (/permission denied|operation not permitted|eacces|eperm/u.test(diagnostic))
    return "permission";
  if (
    /connection refused|connection reset|network is unreachable|timed out|timeout/u.test(diagnostic)
  )
    return "network";
  if (/unauthorized|authentication required|denied: requested access/u.test(diagnostic))
    return "registry-auth";
  if (/manifest unknown|pull access denied|failed to resolve source metadata/u.test(diagnostic))
    return "base-image-unavailable";
  if (
    /no such file or directory|not found in build context|failed to calculate checksum/u.test(
      diagnostic,
    )
  )
    return "build-context";
  if (/cgroup|pids[.]max|clone3/u.test(diagnostic)) return "process-isolation";
  if (/overlay|storage|mount/u.test(diagnostic)) return "storage";
  return "unclassified";
}

/** Keep only fixed failure categories from the fixed live build. */
export async function buildPortableSandboxImageWithEvidence(
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
  artifacts: ArtifactSink,
  progress: TestProgress,
  runBuild: BuildRunner = runPodmanBuild,
): Promise<number | null> {
  const result = await runBuild(args, options.env, BUILD_TIMEOUT_MS, progress);
  if (result.status !== 0 || result.error) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    await artifacts.writeJson("portable-sandbox-image-build-failure.json", {
      schemaVersion: 1,
      status: result.status,
      signal: result.signal,
      errorCode: errorCode && SAFE_ERROR_CODES.has(errorCode) ? errorCode : null,
      category: failureCategory(result.diagnostic),
    });
  }
  return result.status;
}
