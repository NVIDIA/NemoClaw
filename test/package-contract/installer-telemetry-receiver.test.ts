// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "../helpers/installer-sourced-env";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const COMPILED_ENTRY = path.join(REPO_ROOT, "dist/lib/cli/installer-telemetry-entry.js");
const COMPILED_SENDER = path.join(REPO_ROOT, "dist/lib/actions/telemetry/send.js");
const TELEMETRY_CLIENT_ID = "2247027956751513";

const completedConfiguration = {
  agentHarnessId: "hermes",
  agentHarnessStatus: "reported",
  modelId: "Qwen/Qwen3.6-27B-FP8",
  modelStatus: "reported",
  providerProfile: "vllm",
  apiFamily: "openai-completions",
  sandboxOS: "linux",
  sandboxOSStatus: "reported",
  computeDriver: "podman",
  gpuState: "verified",
  webSearchEnabled: true,
  observabilityEnabled: false,
  imageOwnership: "managed",
  policyTier: null,
  policyTierStatus: "not_persisted",
  configuredMessagingChannels: ["slack", "telegram"],
  messagingStatus: "reported",
};

const approvedLocation = {
  countryCode: "DE",
  countryName: "Germany",
  regionName: "Bavaria",
  cityName: "Munich",
  locationSource: "approved_deployment",
  locationStatus: "reported",
  locationPrecision: "city",
  locationObservedAt: "2026-10-01T15:00:00.000Z",
};

function expectedPayload(operation: "update" | "onboard", observed: Record<string, unknown> = {}) {
  const hostOS =
    process.platform === "linux"
      ? "linux"
      : process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : ["aix", "freebsd", "openbsd", "sunos", "android"].includes(process.platform)
            ? "other"
            : "unknown";
  const cpuArchitecture =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : process.arch === "ia32"
          ? "x86"
          : process.arch;
  return {
    browserType: "undefined",
    clientId: TELEMETRY_CLIENT_ID,
    clientType: "Native",
    clientVariant: "Release",
    clientVer: expect.stringMatching(/^\d+\.\d+\.\d+/u),
    cpuArchitecture,
    deviceGdprBehOptIn: "None",
    deviceGdprFuncOptIn: "None",
    deviceGdprTechOptIn: "None",
    deviceId: "undefined",
    deviceMake: "undefined",
    deviceModel: "undefined",
    deviceOS: "undefined",
    deviceOSVersion: "undefined",
    deviceType: "undefined",
    eventProtocol: "1.6",
    eventSchemaVer: "2.2",
    eventSysVer: "nemoclaw-telemetry/2.0",
    externalUserId: "undefined",
    gdprBehOptIn: "None",
    gdprFuncOptIn: "None",
    gdprTechOptIn: "None",
    idpId: "undefined",
    integrationId: "undefined",
    productName: "undefined",
    productVersion: "undefined",
    sentTs: expect.any(String),
    sessionId: "undefined",
    userId: "undefined",
    events: [
      {
        name:
          operation === "update"
            ? "nemoclaw_install_completed"
            : "nemoclaw_configuration_completed",
        parameters: {
          nvidiaSource: "nemoclaw",
          testLabel: "",
          operation,
          configurationScope: operation === "update" ? "operation" : "primary_configuration",
          hostOS,
          hostContext:
            process.platform === "linux" && /microsoft/i.test(os.release()) ? "wsl" : "native",
          hostArch: process.arch,
          agentHarnessId: "unknown",
          agentHarnessStatus: "not_observed",
          modelId: "unknown",
          modelStatus: "not_observed",
          providerProfile: "unknown",
          apiFamily: "unknown",
          sandboxOS: "unknown",
          sandboxOSStatus: "not_observed",
          computeDriver: "unknown",
          gpuState: "unknown",
          webSearchEnabled: "unknown",
          observabilityEnabled: "unknown",
          imageOwnership: "unknown",
          policyTier: "unknown",
          policyTierStatus: "not_persisted",
          configuredMessagingChannels: [],
          messagingStatus: "not_observed",
          countryCode: "",
          countryName: "",
          regionName: "",
          cityName: "",
          locationSource: "none",
          locationStatus: "not_configured",
          locationPrecision: "none",
          locationObservedAt: "",
          ...observed,
        },
        ts: expect.any(String),
      },
    ],
  };
}

async function runInstallerTelemetry(
  sourceRoot: string,
  cliPath: string,
  testLabel?: string,
): Promise<{ status: number | null; output: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `source "$INSTALLER_UNDER_TEST" >/dev/null
NEMOCLAW_SOURCE_ROOT="$SOURCE_ROOT"
_CLI_PATH="$CLI_PATH"
resolve_nemoclaw_gateway_port() { printf '18789'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { :; }
validate_deferred_hermes_onboarding_request() { :; }
install_nemoclaw_before_onboarding() { :; }
command_exists() { return 0; }
registered_sandbox_count() { printf '0\\n'; }
should_defer_hermes_onboarding() { return 1; }
run_installer_host_preflight() { return 0; }
recover_preexisting_sandboxes_before_onboard() { return 0; }
run_onboard() { return 0; }
restore_onboard_forward_after_post_checks() { return 0; }
finalize_install() { :; }
clear_station_resume_after_completed_onboarding() { :; }
main --non-interactive --yes-i-accept-third-party-software`,
      ],
      {
        cwd: REPO_ROOT,
        killSignal: "SIGKILL",
        signal: AbortSignal.timeout(15_000),
        env: {
          HOME: sourceRoot,
          CLI_PATH: cliPath,
          INSTALLER_UNDER_TEST: INSTALLER_PAYLOAD,
          NEMOCLAW_UPDATE_INVOKED: "1",
          PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
          SOURCE_ROOT: sourceRoot,
          NEMOCLAW_TELEMETRY_ENV: "uat",
          ...(testLabel !== undefined ? { NEMOCLAW_TELEMETRY_TEST_LABEL: testLabel } : {}),
        },
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
}

async function listen(server: http.Server): Promise<URL> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/events`);
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

async function receiveInstallerTelemetry(testLabel: string | undefined) {
  const requests: Array<{
    method: string | undefined;
    path: string | undefined;
    contentType: string | undefined;
    accept: string | undefined;
    eventProtocol: string | undefined;
    body: unknown;
  }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        contentType: request.headers["content-type"],
        accept: request.headers.accept,
        eventProtocol: request.headers["x-event-protocol"] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(204).end();
    });
  });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telemetry-receiver-"));

  try {
    const endpoint = await listen(server);
    const entryPath = path.join(temporaryRoot, "dist/lib/cli/installer-telemetry-entry.js");
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    const cliPath = path.join(temporaryRoot, "nemoclaw");
    fs.writeFileSync(cliPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      entryPath,
      `const { runInstallerTelemetryEntry } = require(${JSON.stringify(COMPILED_ENTRY)});\n` +
        `runInstallerTelemetryEntry(process.argv.slice(2), {\n` +
        `  loadConfig: () => ({ endpoint: new URL(${JSON.stringify(endpoint.href)}) }),\n` +
        `}).catch(() => { process.exitCode = 1; });\n`,
    );

    const result = await runInstallerTelemetry(temporaryRoot, cliPath, testLabel);
    return { requests, result };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    await close(server);
  }
}

describe("installer telemetry compiled package", () => {
  it.each([undefined, "", "private@example.com"])(
    "suppresses an absent or malformed inherited QA label %s (#11109)",
    async (testLabel) => {
      expect(fs.existsSync(COMPILED_ENTRY), "Run `npm run build:cli` before this test.").toBe(true);
      const { requests, result } = await receiveInstallerTelemetry(testLabel);
      expect(result.status, result.output).toBe(0);
      expect(requests).toEqual([]);
    },
    25_000,
  );

  it("preserves a valid inherited QA label through the compiled installer client (#11109)", async () => {
    expect(fs.existsSync(COMPILED_ENTRY), "Run `npm run build:cli` before this test.").toBe(true);
    const testLabel = "qa-shanghai-20261005:linux-docker-openclaw:attempt-1";
    const { requests, result } = await receiveInstallerTelemetry(testLabel);
    expect(result.status, result.output).toBe(0);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/events",
        contentType: "application/json;charset=utf-8",
        accept: "application/json",
        eventProtocol: "1.6",
        body: expectedPayload("update", { testLabel }),
      },
    ]);
    const payload = requests[0]?.body as { sentTs?: string; events?: Array<{ ts?: string }> };
    expect(payload.sentTs).toBe(payload.events?.[0]?.ts);
  }, 25_000);

  it("sends every completed configuration field through the compiled client to a local receiver (#10440)", async () => {
    expect(fs.existsSync(COMPILED_SENDER), "Run `npm run build:cli` before this test.").toBe(true);
    const requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }> =
      [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        response.writeHead(204).end();
      });
    });
    try {
      const endpoint = await listen(server);
      const script =
        `const { sendConfigurationTelemetry } = require(${JSON.stringify(COMPILED_SENDER)});\n` +
        `sendConfigurationTelemetry("onboard", () => (${JSON.stringify(completedConfiguration)}), {\n` +
        `  loadConfig: () => ({ endpoint: new URL(${JSON.stringify(endpoint.href)}),\n` +
        `    resolveLocation: async () => (${JSON.stringify(approvedLocation)}) }),\n` +
        `}).then(result => { if (result !== "delivered") process.exitCode = 1; })\n` +
        `  .catch(() => { process.exitCode = 1; });\n`;
      const result = await new Promise<{ status: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, ["-e", script], {
            cwd: REPO_ROOT,
            killSignal: "SIGKILL",
            signal: AbortSignal.timeout(10_000),
            env: { PATH: path.dirname(process.execPath) },
          });
          let output = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, output }));
        },
      );
      expect(result.status, result.output).toBe(0);
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/events",
          body: expectedPayload("onboard", {
            ...completedConfiguration,
            ...approvedLocation,
            webSearchEnabled: "true",
            observabilityEnabled: "false",
            policyTier: "unknown",
          }),
        },
      ]);
      expect(JSON.stringify(requests)).not.toContain("isSynthetic");
      expect(JSON.stringify(requests)).not.toContain("recordId");
    } finally {
      await close(server);
    }
  }, 15_000);
});
