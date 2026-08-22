// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  DockerSpawnSyncOptions,
  DockerSpawnSyncResult,
} from "../../src/lib/adapters/docker/exec";
import { dockerSpawnSync } from "../../src/lib/adapters/docker/exec";

export const OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS = 15_000;
export const OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS = 5 * 60_000;

const PULL_CAPTURE_MAX_BYTES = 256 * 1024;
const PULL_DIAGNOSTIC_MAX_BYTES = 4 * 1024;
const TRUNCATION_SUFFIX = "\n[diagnostic truncated]";

export type DockerImageSetupRunner = (
  args: readonly string[],
  options: DockerSpawnSyncOptions,
) => Pick<DockerSpawnSyncResult, "error" | "signal" | "status" | "stderr" | "stdout">;

function outputText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

function boundedTail(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;

  const contentLimit = maximumBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  let content = "";
  let contentBytes = 0;
  for (const character of Array.from(value).reverse()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (contentBytes + characterBytes > contentLimit) break;
    content = character + content;
    contentBytes += characterBytes;
  }
  return `${content}${TRUNCATION_SUFFIX}`;
}

function pullFailureReason(result: ReturnType<DockerImageSetupRunner>): string {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === "ETIMEDOUT" ? "timed out" : "failed to execute";
  }
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited with status ${String(result.status)}`;
}

function pullFailureDiagnostic(result: ReturnType<DockerImageSetupRunner>): string {
  const output = [outputText(result.stderr), outputText(result.stdout)]
    .filter((entry) => entry.length > 0)
    .join("\n")
    .trim();
  return output.length > 0
    ? boundedTail(output, PULL_DIAGNOSTIC_MAX_BYTES)
    : "docker pull produced no diagnostic output";
}

export function ensureOpenClawGeminiRuntimeImage(
  image: string,
  runDocker: DockerImageSetupRunner = dockerSpawnSync,
): "cached" | "pulled" {
  const inspect = runDocker(["image", "inspect", image], {
    stdio: "ignore",
    timeout: OPENCLAW_GEMINI_IMAGE_INSPECT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (inspect.status === 0) return "cached";

  const pull = runDocker(["pull", image], {
    encoding: "utf8",
    timeout: OPENCLAW_GEMINI_IMAGE_PULL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: PULL_CAPTURE_MAX_BYTES,
  });
  if (pull.status === 0) return "pulled";

  throw new Error(
    `Pinned OpenClaw runtime image pull ${pullFailureReason(pull)}: ${image}\n${pullFailureDiagnostic(pull)}`,
  );
}
