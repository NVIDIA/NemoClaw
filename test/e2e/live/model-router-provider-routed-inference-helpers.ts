// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_GATEWAY_PORT, parsePort } from "../../../src/lib/core/ports.ts";
import { resolveModelRouterLogPath } from "../../../src/lib/onboard/model-router.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

// Use only the shipped pool's public origin. HTTPSConnection does not follow redirects.
// Never serialize credentials, response text, headers, or exception messages.
export const ROUTER_PROVIDER_FAILURE_DIAGNOSTIC = String.raw`
import concurrent.futures
import http.client
import importlib.metadata
import json
import os
import re
import sys
import time

def probe(model):
    started = time.monotonic()
    connection = http.client.HTTPSConnection("integrate.api.nvidia.com", timeout=60)
    result = {"model": model}
    try:
        connection.request("POST", "/v1/chat/completions",
            body=json.dumps({"model": model, "messages": [{"role": "user", "content": "What's 1 + 1?"}], "max_tokens": 1, "stream": False}),
            headers={"Authorization": "Bearer " + os.environ["NVIDIA_INFERENCE_API_KEY"], "Content-Type": "application/json"})
        result["requestSentMs"] = round((time.monotonic() - started) * 1000)
        response = connection.getresponse()
        result["status"] = response.status
        result["responseHeadersMs"] = round((time.monotonic() - started) * 1000)
        body = response.read(65537)
        result.update(outcome="http-response", status=response.status, bodyBytes=len(body), truncated=len(body)>65536)
    except TimeoutError:
        result["outcome"] = "timeout"
    except Exception:
        result["outcome"] = "client-error"
    finally:
        connection.close()
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    return result

versions = {}
for package in ["model-router-toolkit", "litellm", "openai", "httpx", "httpcore", "aiohttp", "fastapi", "starlette", "uvicorn", "pydantic"]:
    try:
        version = importlib.metadata.version(package)
        versions[package] = version if re.fullmatch(r"[0-9][A-Za-z0-9.+!_-]{0,79}", version) else "nonstandard-version"
    except Exception:
        versions[package] = None
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(probe, ["openai/gpt-oss-20b", "nvidia/nemotron-3-super-120b-a12b"]))
print(json.dumps({"schemaVersion": 1, "python": list(sys.version_info[:3]), "packages": versions, "client": "stdlib-https", "socketTimeoutSeconds": 60, "results": results}))
`;

export async function recordRouterFailureDiagnostics(
  host: HostCliClient,
  artifacts: ArtifactSink,
  exitCode: number | null,
  onboardEnv: NodeJS.ProcessEnv,
  redactionValues: string[],
): Promise<void> {
  if (exitCode === 0) return;
  const port = parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, onboardEnv);
  const stateRoot = path.dirname(path.dirname(resolveModelRouterLogPath(onboardEnv.HOME, port)));
  try {
    await host.command(
      path.join(stateRoot, "model-router-venv", "bin", "python"),
      ["-I", "-c", ROUTER_PROVIDER_FAILURE_DIAGNOSTIC],
      {
        artifactName: "router-provider-failure-diagnostics",
        env: onboardEnv,
        redactionValues,
        captureLimitBytes: 8_192,
        timeoutMs: 75_000,
      },
    );
  } catch {
    // Diagnostic failure must not replace the original onboarding assertion.
    await artifacts.writeJson("router-provider-failure-diagnostics.json", { available: false });
  }
}

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
  logPath = resolveModelRouterLogPath(),
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

export function registerRouterDiagnostics(
  cleanup: CleanupRegistry,
  artifacts: ArtifactSink,
  onboardEnv: NodeJS.ProcessEnv,
): void {
  // The filtered child environment can select a different port than the test process.
  const logPath = resolveModelRouterLogPath(
    undefined,
    parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, onboardEnv),
  );
  // Register after sandbox cleanup so the LIFO registry captures the log before destruction.
  cleanup.add("retain Model Router diagnostics", () => retainRouterDiagnostics(artifacts, logPath));
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
