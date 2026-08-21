// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "./clients/sandbox.ts";
import type { CleanupRegistry } from "./cleanup.ts";

interface Issue4462FailureDiagnosticsOptions {
  env: NodeJS.ProcessEnv;
  redactionValues: readonly string[];
  sandboxName: string;
}

const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json";
const PAIRING_LOG_PATHS = ["/tmp/auto-pair.log", "/tmp/gateway.log"] as const;

const REDACT_PAIRING_DIAGNOSTICS_PROGRAM = String.raw`
"use strict";
const fs = require("node:fs");
const [configPath, ...logPaths] = process.argv.slice(1);
const MAX_LOG_BYTES = 384 * 1024;

function readTail(logPath) {
  const fd = fs.openSync(logPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text.split(/\r?\n/).slice(-400).join("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function redact(text, gatewayToken) {
  return text
    .split(gatewayToken).join("[REDACTED_OPENCLAW_GATEWAY_TOKEN]")
    .replace(/nvapi-[A-Za-z0-9._-]+/g, "[REDACTED_NVIDIA_INFERENCE_API_KEY]")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/((?:Authorization|Proxy-Authorization)\s*[:=]\s*)(?:Bearer\s+)?[A-Za-z0-9._~+/=:-]+/gi, "$1[REDACTED_AUTHORIZATION]")
    .replace(/(\"(?:Authorization|Proxy-Authorization)\"\s*:\s*\")(?:(?:Bearer)\s+)?(?:\\.|[^\"\\])*(\")/gi, "$1[REDACTED_AUTHORIZATION]$2")
    .replace(/((?:x-)?api[-_]?key\s*[:=]\s*)[A-Za-z0-9._-]+/gi, "$1[REDACTED_API_KEY]")
    .replace(/(\"(?:x-)?api[-_]?key\"\s*:\s*\")(?:\\.|[^\"\\])*(\")/gi, "$1[REDACTED_API_KEY]$2")
    .replace(/([?&](?:token|auth_token|gateway_token|gatewayAuthToken|access_token)=)[^ \t\r\n&\"'<>]+/gi, "$1[REDACTED_TOKEN]")
    .replace(/(\"(?:token|auth_token|gateway_token|gatewayAuthToken|access_token)\"\s*:\s*\")(?:\\.|[^\"\\])*(\")/gi, "$1[REDACTED_TOKEN]$2")
    .replace(/((?:prompt|content|message|text)\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\r\n]+)/gi, "$1[REDACTED_TEXT]")
    .replace(/(\"(?:prompt|content|message|text)\"\s*:\s*\")(?:\\.|[^\"\\])*(\")/gi, "$1[REDACTED_TEXT]$2");
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const gatewayToken = config?.gateway?.auth?.token || config?.gateway?.authToken;
  if (typeof gatewayToken !== "string" || gatewayToken.length === 0) {
    throw new Error("gateway token unavailable");
  }
  const sections = logPaths.map((logPath) => {
    let content;
    try {
      content = readTail(logPath);
    } catch {
      content = "unavailable";
    }
    return "== " + logPath + " ==\n" + redact(content, gatewayToken);
  });
  process.stdout.write(sections.join("\n") + "\n");
} catch {
  process.stdout.write("pairing diagnostics unavailable: redaction prerequisites failed\n");
  process.exitCode = 1;
}
`;

export function buildIssue4462DiagnosticsCommand(
  configPath = OPENCLAW_CONFIG_PATH,
  logPaths: readonly string[] = PAIRING_LOG_PATHS,
): string[] {
  return ["node", "-e", REDACT_PAIRING_DIAGNOSTICS_PROGRAM, configPath, ...logPaths];
}

/** Preserve startup pairing evidence without replacing the scenario's primary failure. */
export async function captureIssue4462FailureDiagnostics(
  sandbox: Pick<SandboxClient, "exec">,
  options: Issue4462FailureDiagnosticsOptions,
): Promise<void> {
  try {
    await sandbox.exec(options.sandboxName, buildIssue4462DiagnosticsCommand(), {
      artifactName: "failure-openclaw-pairing-diagnostics",
      captureLimitBytes: 1024 * 1024,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 30_000,
    });
  } catch {
    // Preserve the primary failure when the sandbox or its logs are unavailable.
  }
}

export function trackIssue4462FailureDiagnostics(
  cleanup: Pick<CleanupRegistry, "trackDisposable">,
  sandbox: Pick<SandboxClient, "exec">,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: readonly string[],
): void {
  cleanup.trackDisposable("capture OpenClaw pairing failure diagnostics", () =>
    captureIssue4462FailureDiagnostics(sandbox, { env, redactionValues, sandboxName }),
  );
}
