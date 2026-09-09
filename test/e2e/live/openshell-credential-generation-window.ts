// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";

/** Exercise repeated secret refreshes without changing the authorization epoch. */
export const CREDENTIAL_WINDOW_REFRESH_COUNT = 9;

export const CREDENTIAL_WINDOW_ENV_NAME = "FAKE_MCP_SECRET";
export const CREDENTIAL_WINDOW_REQUEST_PREFIX = "nemoclaw-credential-window";
export const CREDENTIAL_WINDOW_PATHS = {
  control: "/tmp/nemoclaw-credential-window.control",
  ready: "/tmp/nemoclaw-credential-window.ready.json",
  acknowledgement: "/tmp/nemoclaw-credential-window.ack.json",
} as const;

export const CREDENTIAL_WINDOW_STEPS = {
  allowedAfterRefresh: "allowed-after-refresh",
  allowedAfterRotations: "allowed-after-rotations",
  deniedAfterKeyRemoval: "denied-after-key-removal",
  deniedAfterKeyRestore: "denied-after-key-restore",
  allowedBeforeDetach: "allowed-before-detach",
  deniedAfterDetach: "denied-after-detach",
  deniedAfterReadd: "denied-after-readd",
  stop: "stop",
} as const;

export type CredentialWindowRequestStep =
  | (typeof CREDENTIAL_WINDOW_STEPS)["allowedAfterRefresh"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["allowedAfterRotations"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterKeyRemoval"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterKeyRestore"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["allowedBeforeDetach"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterDetach"]
  | (typeof CREDENTIAL_WINDOW_STEPS)["deniedAfterReadd"];

export function credentialWindowSecret(generation: number): string {
  return `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}${String(generation).padStart(2, "0")}`;
}

export function credentialWindowSecrets(): string[] {
  return Array.from(
    { length: CREDENTIAL_WINDOW_REFRESH_COUNT + 3 },
    (_, generation) => credentialWindowSecret(generation),
  );
}

export function credentialWindowRequestId(
  step: CredentialWindowRequestStep,
): string {
  return `${CREDENTIAL_WINDOW_REQUEST_PREFIX}:${step}`;
}

export function buildCredentialWindowProviderUpdateArgs(
  providerName: string,
  removeCredential = false,
): string[] {
  return [
    "provider",
    "update",
    providerName,
    "--credential",
    removeCredential
      ? `${CREDENTIAL_WINDOW_ENV_NAME}=`
      : CREDENTIAL_WINDOW_ENV_NAME,
  ];
}

export interface CredentialWindowChildOptions {
  readonly mcpUrl: string;
  readonly maxRuntimeMs?: number;
  readonly paths?: {
    readonly control: string;
    readonly ready: string;
    readonly acknowledgement: string;
  };
}

/**
 * Build the process held open across provider mutations. It snapshots the
 * stable credential handle exactly once, accepts only seven bounded request steps
 * plus stop, and reports only handle/status metadata. The credential placeholder
 * is used solely as the Authorization header so the OpenShell proxy must resolve
 * it on each request.
 */
export function buildCredentialWindowChildScript(
  options: CredentialWindowChildOptions,
): string {
  const config = JSON.stringify({
    acknowledgementPath: (options.paths ?? CREDENTIAL_WINDOW_PATHS)
      .acknowledgement,
    controlPath: (options.paths ?? CREDENTIAL_WINDOW_PATHS).control,
    envName: CREDENTIAL_WINDOW_ENV_NAME,
    maxRuntimeMs: options.maxRuntimeMs ?? 40 * 60_000,
    mcpUrl: options.mcpUrl,
    readyPath: (options.paths ?? CREDENTIAL_WINDOW_PATHS).ready,
    requestPrefix: CREDENTIAL_WINDOW_REQUEST_PREFIX,
    steps: CREDENTIAL_WINDOW_STEPS,
  });

  return `
const fs = require("node:fs");
const https = require("node:https");
const config = ${config};
const credentialPlaceholder = process.env[config.envName] || "";
const stableHandlePattern = new RegExp(
  "^openshell:resolve:env:(s[a-f0-9]{64})_" + config.envName + "$",
);
const stableHandleMatch = stableHandlePattern.exec(credentialPlaceholder);
if (!stableHandleMatch) throw new Error("old child did not receive a stable credential handle");
const stableHandle = stableHandleMatch[1];
const target = new URL(config.mcpUrl);
const requestSteps = new Set([
  config.steps.allowedAfterRefresh,
  config.steps.allowedAfterRotations,
  config.steps.deniedAfterKeyRemoval,
  config.steps.deniedAfterKeyRestore,
  config.steps.allowedBeforeDetach,
  config.steps.deniedAfterDetach,
  config.steps.deniedAfterReadd,
]);
const seen = new Set();
const outcomes = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const writePrivateJson = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value) + "\\n", { encoding: "utf8", mode: 0o600 });
};
const request = (step) => new Promise((resolve) => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: config.requestPrefix + ":" + step,
    method: "tools/list",
  });
  const outbound = https.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      authorization: "Bearer " + credentialPlaceholder,
    },
  }, (response) => {
    response.resume();
    response.on("end", () => resolve(response.statusCode === 200 ? "allowed" : "denied"));
  });
  outbound.on("error", () => resolve("denied"));
  outbound.setTimeout(30_000, () => outbound.destroy());
  outbound.end(body);
});

writePrivateJson(config.readyPath, { stableHandle });
const deadline = Date.now() + config.maxRuntimeMs;
(async () => {
  let stopped = false;
  while (Date.now() < deadline && !stopped) {
    const step = fs.existsSync(config.controlPath)
      ? fs.readFileSync(config.controlPath, "utf8").trim()
      : "";
    if (step === config.steps.stop) {
      stopped = true;
    } else if (requestSteps.has(step) && !seen.has(step)) {
      seen.add(step);
      const outcome = await request(step);
      outcomes.push({ step, outcome });
      writePrivateJson(config.acknowledgementPath, { step, outcome });
    }
    if (!stopped) await delay(200);
  }
  if (!stopped) throw new Error("credential generation window child exceeded its deadline");
  process.stdout.write(JSON.stringify({ stableHandle, outcomes }) + "\\n");
})().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exitCode = 1;
});
`.trim();
}

export function buildCredentialWindowOneShotScript(): string {
  const config = JSON.stringify({
    envName: CREDENTIAL_WINDOW_ENV_NAME,
  });
  return `
const https = require("node:https");
const config = ${config};
const credentialPlaceholder = process.env[config.envName] || "";
const stableHandlePattern = new RegExp(
  "^openshell:resolve:env:(s[a-f0-9]{64})_" + config.envName + "$",
);
const stableHandleMatch = stableHandlePattern.exec(credentialPlaceholder);
if (!stableHandleMatch) throw new Error("fresh child did not receive a stable credential handle");
const target = new URL(process.argv[1]);
const body = JSON.stringify({ jsonrpc: "2.0", id: process.argv[2], method: "tools/list" });
const request = https.request({
  hostname: target.hostname,
  port: target.port,
  path: target.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    authorization: "Bearer " + credentialPlaceholder,
  },
}, (response) => {
  response.resume();
  response.on("end", () => {
    process.stdout.write(JSON.stringify({ stableHandle: stableHandleMatch[1], status: response.statusCode }) + "\\n");
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  });
});
request.on("error", (error) => {
  process.stderr.write(error.name + "\\n");
  process.exitCode = 1;
});
request.setTimeout(30_000, () => request.destroy());
request.end(body);
`.trim();
}
