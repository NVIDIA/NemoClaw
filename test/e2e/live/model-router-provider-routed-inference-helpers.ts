// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNemoclawStateDir } from "../../../src/lib/state/paths.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";

export function summarizeRouterLog(text: string) {
  // Export only fixed booleans and counts. Never retain log lines or captured text.
  return {
    strategyRegistered: text.includes("strategy registered in"),
    warmupCompleted: /Warmup route\s+:/.test(text),
    warmupFailed: text.includes("Warmup route failed"),
    strategyInjectionFailed: text.includes("Failed to inject routing strategy at startup"),
    timeoutReported: /timeout|timed out/i.test(text),
    authenticationErrorReported: /AuthenticationError|Unauthorized|Invalid API Key/i.test(text),
    rateLimitReported: /RateLimitError|Too Many Requests/i.test(text),
    connectionErrorReported: /APIConnectionError|ConnectionError|Connection refused/i.test(text),
    completionResponses: [
      ...text.matchAll(/"POST \/v1\/chat\/completions HTTP\/1\.[01]" [1-5][0-9]{2}/g),
    ].length,
  };
}

export async function retainRouterDiagnostics(
  artifacts: ArtifactSink,
  logPath = path.join(resolveNemoclawStateDir(os.homedir()), "model-router.log"),
): Promise<void> {
  let descriptor: number | undefined;
  let summary: object;
  try {
    descriptor = fs.openSync(
      logPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(descriptor);
    if (stat.isFile()) {
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, stat.size - buffer.length);
      summary = {
        available: true,
        truncated: stat.size > buffer.length,
        ...summarizeRouterLog(buffer.subarray(0, bytes).toString("utf8")),
      };
    } else {
      summary = { available: false };
    }
  } catch {
    summary = { available: false };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  await artifacts.writeJson("router-diagnostics.json", summary);
}

export function buildProviderRoutedEnv(
  apiKey: string,
  sandboxName: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(baseEnv),
    // CI's NVIDIA_API_KEY is the public nvapi-* credential for
    // integrate.api.nvidia.com. The routed blueprint still declares the
    // historical NVIDIA_INFERENCE_API_KEY runtime credential name, so alias
    // the public value only in this child environment. Hosted lanes instead
    // source their sk-* NVIDIA_INFERENCE_API_KEY for inference-api.nvidia.com.
    NVIDIA_INFERENCE_API_KEY: apiKey,
    NEMOCLAW_PROVIDER_KEY: apiKey,
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_POLICY_MODE: "skip",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_PROVIDER: "routed",
  };
}
