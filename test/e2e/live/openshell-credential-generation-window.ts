// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";

/** OpenShell f27ff150 retains exactly this many revision resolvers. */
export const OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS = 8;

/** One more update than the retained window guarantees eviction of revision zero. */
export const CREDENTIAL_WINDOW_ROTATION_COUNT = OPENSHELL_RETAINED_CREDENTIAL_GENERATIONS + 1;
export const CREDENTIAL_WINDOW_EXPIRY_DELAY_MS = 3 * 60_000;

export const CREDENTIAL_WINDOW_ENV_NAME = "FAKE_MCP_SECRET";
export const CREDENTIAL_WINDOW_REQUEST_PREFIX = "nemoclaw-credential-window";
export const CREDENTIAL_WINDOW_PATHS = {
  control: "/tmp/nemoclaw-credential-window.control",
  ready: "/tmp/nemoclaw-credential-window.ready.json",
  acknowledgement: "/tmp/nemoclaw-credential-window.ack.json",
} as const;

export const CREDENTIAL_WINDOW_STEPS = {
  allowedBeforeExpiry: "allowed-before-expiry",
  deniedAfterExpiry: "denied-after-expiry",
  fallbackAfterEviction: "fallback-after-eviction",
  deniedAfterCurrentExpiry: "denied-after-current-expiry",
  deniedAfterDetach: "denied-after-detach",
  deniedAfterReadd: "denied-after-readd",
  stop: "stop",
} as const;

export type CredentialWindowRequestStep =
  | (typeof CREDENTIAL_WINDOW_STEPS)["allowedBeforeExpiry"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterExpiry"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["fallbackAfterEviction"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterCurrentExpiry"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterDetach"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterReadd"];

export function credentialWindowSecret(generation: number): string {
  return `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}${String(generation).padStart(2, "0")}`;
}

export function credentialWindowSecrets(): string[] {
  return Array.from({ length: CREDENTIAL_WINDOW_ROTATION_COUNT + 3 }, (_, generation) =>
    credentialWindowSecret(generation),
  );
}

export function credentialWindowRequestId(step: CredentialWindowRequestStep): string {
  return `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:${step}`;
}

export function buildCredentialWindowProviderUpdateArgs(
  providerName: string,
  expiresAtMs: number,
): string[] {
  return [
    "provider",
    "update",
    providerName,
    "--credential",
    CREDENTIAL_WINDOW_ENV_NAME,
    "--credential-expires-at",
    `${CREDENTIAL_WINDOW_ENV_NAME}=${expiresAtMs}`,
  ];
}

export interface CredentialWindowChildOptions {
  readonly mcpUrl: string;
  readonly maxRuntimeMs?: number;
}

// Both probes retain one credential handle and use the same bounded MCP transport.
const MCP_SESSION_SCRIPT = `
const https = require("node:https");
const credentialPlaceholder = process.env[config.envName] || "";
const revisionPattern = new RegExp(
  "^openshell:resolve:env:(v[0-9]{1,20})_" + config.envName + "$",
);
const revisionMatch = revisionPattern.exec(credentialPlaceholder);
if (!revisionMatch) throw new Error("child did not receive a revision-scoped credential");
const revision = revisionMatch[1];
const finish = (exitCode, summary = "", diagnostic = "") => {
  process.stdout.write(summary);
  process.stderr.write(diagnostic);
  process.exitCode = exitCode;
};
const sendMcp = (message, sessionId) => new Promise((resolve, reject) => {
  const body = JSON.stringify(message);
  const request = https.request({
    hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",
    headers: {
      "content-type": "application/json", "content-length": Buffer.byteLength(body),
      authorization: "Bearer " + credentialPlaceholder,
      ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-11-25" } : {}),
    },
  }, (response) => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      text += chunk;
      if (text.length > 65536) request.destroy(new Error("MCP response exceeded its limit"));
    });
    response.on("error", () => reject(new Error("MCP response failed")));
    response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
  });
  request.on("error", (error) => reject(Object.assign(new Error("MCP request failed"), { code: error.code })));
  request.setTimeout(30_000, () => request.destroy(new Error("MCP request timed out")));
  request.end(body);
});
const negotiateSession = async () => {
  const initialized = await sendMcp({
    jsonrpc: "2.0", id: "credential-window-initialize", method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "credential-window", version: "1" } },
  });
  const sessionId = initialized.headers["mcp-session-id"];
  let version;
  try { version = JSON.parse(initialized.text).result?.protocolVersion; } catch {}
  if (initialized.status !== 200 || version !== "2025-11-25" ||
      typeof sessionId !== "string" || !/^[\\x21-\\x7e]{1,256}$/.test(sessionId)) {
    throw new Error("MCP session negotiation failed");
  }
  const ready = await sendMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  if (ready.status !== 202) throw new Error("MCP session initialization failed");
  return sessionId;
};
`;

/**
 * Build the process held open across provider mutations. It snapshots the
 * revisioned child environment exactly once, accepts only six bounded request
 * steps plus stop, and reports only revision/status metadata. The credential
 * placeholder is used solely as the Authorization header so the OpenShell proxy
 * must resolve it on each request.
 */
export function buildCredentialWindowChildScript(options: CredentialWindowChildOptions): string {
  const config = JSON.stringify({
    acknowledgementPath: CREDENTIAL_WINDOW_PATHS.acknowledgement,
    controlPath: CREDENTIAL_WINDOW_PATHS.control,
    envName: CREDENTIAL_WINDOW_ENV_NAME,
    maxRuntimeMs: options.maxRuntimeMs ?? 40 * 60_000,
    mcpUrl: options.mcpUrl,
    readyPath: CREDENTIAL_WINDOW_PATHS.ready,
    requestPrefix: CREDENTIAL_WINDOW_REQUEST_PREFIX,
    steps: CREDENTIAL_WINDOW_STEPS,
  });

  return `
const fs = require("node:fs");
const config = ${config};
const target = new URL(config.mcpUrl);
${MCP_SESSION_SCRIPT}
let sessionId;
const requestSteps = new Set([
  config.steps.allowedBeforeExpiry,
  config.steps.deniedAfterExpiry,
  config.steps.fallbackAfterEviction,
  config.steps.deniedAfterCurrentExpiry,
  config.steps.deniedAfterDetach,
  config.steps.deniedAfterReadd,
]);
const seen = new Set();
const outcomes = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const writePrivateJson = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value) + "\\n", { encoding: "utf8", mode: 0o600 });
};
const request = async (step) => {
  try {
    const response = await sendMcp({
      jsonrpc: "2.0", id: config.requestPrefix + ":" + step, method: "tools/list",
    }, sessionId);
    return {
      outcome: response.status === 200 ? "allowed" : "denied",
      httpStatus: response.status,
    };
  } catch (error) {
    const knownCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]);
    return { outcome: "denied", transportCode: knownCodes.has(error.code) ? error.code : "OTHER" };
  }
};

const deadline = Date.now() + config.maxRuntimeMs;
(async () => {
  sessionId = await negotiateSession();
  writePrivateJson(config.readyPath, { revision });
  let stopped = false;
  while (Date.now() < deadline && !stopped) {
    const step = fs.existsSync(config.controlPath)
      ? fs.readFileSync(config.controlPath, "utf8").trim()
      : "";
    if (step === config.steps.stop) {
      stopped = true;
    } else if (requestSteps.has(step) && !seen.has(step)) {
      seen.add(step);
      const observation = await request(step);
      process.stderr.write(JSON.stringify({ step, ...observation }) + "\\n");
      const outcome = observation.outcome;
      outcomes.push({ step, outcome });
      writePrivateJson(config.acknowledgementPath, { step, outcome });
    }
    await delay(200);
  }
  if (!stopped) throw new Error("credential generation window child exceeded its deadline");
  process.stdout.write(JSON.stringify({ revision, outcomes }) + "\\n");
})().catch((error) => {
  finish(1, "", String(error && error.message ? error.message : error) + "\\n");
});
`.trim();
}

export function buildCredentialWindowOneShotScript(): string {
  const config = JSON.stringify({
    envName: CREDENTIAL_WINDOW_ENV_NAME,
  });
  return `
const config = ${config};
const target = new URL(process.argv[1]);
${MCP_SESSION_SCRIPT}
(async () => {
  const sessionId = await negotiateSession();
  const response = await sendMcp({ jsonrpc: "2.0", id: process.argv[2], method: "tools/list" }, sessionId);
  finish(response.status === 200 ? 0 : 1, JSON.stringify({ revision, status: response.status }) + "\\n");
})().catch(() => finish(1, "", "MCP credential request failed\\n"));
`.trim();
}
