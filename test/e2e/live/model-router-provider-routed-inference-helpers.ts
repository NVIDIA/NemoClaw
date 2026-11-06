// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { DEFAULT_GATEWAY_PORT, parsePort } from "../../../src/lib/core/ports.ts";
import { resolveModelRouterLogPath } from "../../../src/lib/onboard/model-router.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { buildTrustedProxyEnvSourceShell } from "../../../src/lib/actions/sandbox/trusted-proxy-env.ts";

export function summarizeRouterLog(text: string) {
  // Export only fixed booleans and counts. Never retain log lines or captured text.
  return {
    strategyRegistered:
      text.includes("strategy registered in") ||
      text.includes("Model Router rules policy registered"),
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

export const ROUTER_LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const ROUTER_SUPER_VL = "nvidia/nemotron-3.5-super-vl-120b-a12b";

/** Export only configured selection identifiers from this turn's log interval. */
export function routerSelectionsSince(logPath: string, offset: number) {
  const fd = fs.openSync(
    logPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size - offset > 64 * 1024 || offset > stat.size)
      throw new Error("Router selection log interval is unavailable.");
    const buffer = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    return [
      ...buffer
        .toString("utf8")
        .matchAll(
          /Model Router selected=(nvidia\/nemotron-3\.5-(?:lightning-30b-a3b|super-vl-120b-a12b)) rule=(text|image|explicit)/g,
        ),
    ].map((match) => ({ model: match[1], rule: match[2] }));
  } finally {
    fs.closeSync(fd);
  }
}

/** Host-owned turns need authenticated admin admission for provider/model overrides. */
export function modelRouterAgentCommand(params: Record<string, unknown>): string[] {
  return [
    "bash",
    "-lc",
    `set -eu
${buildTrustedProxyEnvSourceShell()}
: "\${OPENCLAW_GATEWAY_TOKEN:?The OpenClaw gateway token is required.}"
exec node --input-type=module --eval "$1" "$2" "\${OPENCLAW_BIN:-$(command -v openclaw)}"
`,
    "model-router-agent",
    MODEL_ROUTER_AGENT_PROGRAM,
    Buffer.from(JSON.stringify(params)).toString("base64"),
  ];
}

const MODEL_ROUTER_AGENT_PROGRAM = String.raw`
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const rawPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
const url = new URL("ws://127.0.0.1:" + Number(rawPort));
const require = createRequire(realpathSync(process.argv[2]));
const { callGatewayFromCli } = await import(pathToFileURL(require.resolve("openclaw/plugin-sdk/gateway-runtime")));
const result = await callGatewayFromCli("agent", {
  url: url.href,
  token,
  timeout: "180000",
  expectFinal: true,
  json: true,
}, JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8")), {
  clientName: "gateway-client",
  mode: "backend",
  scopes: ["operator.admin"],
  progress: false,
});
process.stdout.write(JSON.stringify(result) + "\n");
`;
