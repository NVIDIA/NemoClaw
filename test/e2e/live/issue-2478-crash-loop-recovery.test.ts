// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the contract with real Docker/OpenShell/NemoClaw boundaries:
 * onboard an OpenClaw sandbox, pause and recover the gateway via the production
 * `connect --probe-only` path, verify the guard-chain preloads remain present,
 * prove inference.local keeps serving models, and verify that the recovered
 * process identity remains unchanged for 15 seconds. Deterministic tests cover repeated
 * restoration and missing `/tmp` proxy environment state.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { ubuntuRepoManagedRuntime } from "../registry/matrix.ts";

const ENVIRONMENT = ubuntuRepoManagedRuntime("cloud-openclaw");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-2478";
const STABILITY_SECONDS = 15;
const COMPATIBLE_MODEL = process.env.NEMOCLAW_COMPAT_MODEL ?? "test-model";
const COMPATIBLE_AUTH_VALUE = ["nemoclaw", "e2e", "compatible", "mock"].join("-");
const ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];

function probeEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

interface FakeOpenAiEndpoint {
  baseUrl: string;
  close: () => Promise<void>;
  requests: () => readonly string[];
}

function jsonResponse(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function startCompatibleEndpointMock(artifacts: ArtifactSink): Promise<FakeOpenAiEndpoint> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const requestPath = request.url?.split("?", 1)[0] ?? "/";
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push(`${request.method ?? "GET"} ${requestPath} ${rawBody}`.slice(0, 1_000));

      if (request.method === "GET" && ["/v1/models", "/models"].includes(requestPath)) {
        jsonResponse(response, 200, {
          object: "list",
          data: [{ id: COMPATIBLE_MODEL, object: "model" }],
        });
        return;
      }

      if (
        request.method === "POST" &&
        ["/v1/chat/completions", "/chat/completions"].includes(requestPath)
      ) {
        jsonResponse(response, 200, {
          id: "chatcmpl-2478-mock",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "OK" },
              finish_reason: "stop",
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && ["/v1/responses", "/responses"].includes(requestPath)) {
        jsonResponse(response, 200, {
          id: "resp-2478-mock",
          object: "response",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            },
          ],
        });
        return;
      }

      jsonResponse(response, 404, { error: { message: "not found" } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("issue-2478 compatible endpoint mock did not bind to a TCP port");
  }
  const port = (address as AddressInfo).port;
  const baseUrl = `http://host.openshell.internal:${port}/v1`;
  await artifacts.writeJson("compatible-endpoint-mock.json", {
    baseUrl,
    model: COMPATIBLE_MODEL,
  });

  return {
    baseUrl,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function cleanupSandbox(host: HostCliClient, sandboxName: string): Promise<void> {
  const result = await host.nemoclaw([sandboxName, "destroy", "--yes"], {
    artifactName: `cleanup-destroy-${sandboxName}`,
    env: probeEnv(),
    timeoutMs: 15 * 60_000,
  });
  if (result.exitCode === 0) return;
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (
    /Sandbox '.+' does not exist|Run 'nemoclaw onboard' to create one|sandbox .* not found|no such sandbox/i.test(
      text,
    )
  ) {
    return;
  }
  expect(result.exitCode, `cleanup destroy sandbox ${sandboxName}\n${text}`).toBe(0);
}

async function onboardWithCompatibleEndpoint(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  sandboxName: string,
  endpoint: FakeOpenAiEndpoint,
): Promise<NemoClawInstance> {
  await cleanupSandbox(host, sandboxName);
  const result = await host.nemoclaw(ONBOARD_ARGS, {
    artifactName: "onboard-compatible-openclaw",
    env: {
      ...probeEnv(),
      COMPATIBLE_API_KEY: COMPATIBLE_AUTH_VALUE,
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_AGENT: "openclaw",
      NEMOCLAW_ENDPOINT_URL: endpoint.baseUrl,
      NEMOCLAW_MODEL: COMPATIBLE_MODEL,
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_SANDBOX_NAME: sandboxName,
    },
    redactionValues: [COMPATIBLE_AUTH_VALUE],
    timeoutMs: 15 * 60_000,
  });
  expect(
    result.exitCode,
    `compatible OpenClaw onboard failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  cleanup.trackSandbox(host, sandboxName, {
    artifactName: `cleanup-destroy-${sandboxName}`,
    env: probeEnv(),
    timeoutMs: 15 * 60_000,
  });

  return {
    onboarding: "cloud-openclaw",
    sandboxName,
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result,
  };
}

type GatewayProcessIdentity = { pid: number; startIdentity: string };

async function waitForGatewayIdentity(
  gateway: {
    resolveGatewayIdentity(instance: NemoClawInstance): Promise<GatewayProcessIdentity | null>;
  },
  instance: NemoClawInstance,
  timeoutMs: number,
): Promise<GatewayProcessIdentity | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await gateway.resolveGatewayIdentity(instance);
    if (identity !== null) return identity;
    await sleep(2_000);
  }
  return null;
}

async function runProbeOnly(
  host: {
    nemoclaw(
      args?: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  artifactName: string,
): Promise<void> {
  const result = await host.nemoclaw([sandboxName, "connect", "--probe-only"], {
    artifactName,
    env: probeEnv(),
    timeoutMs: 90_000,
  });
  expect(
    result.exitCode,
    `${artifactName} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

async function terminateGatewayIdentity(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  identity: GatewayProcessIdentity,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-c",
      [
        "set -eu",
        'pid="$1"',
        'expected_start="$2"',
        "inspect_identity() {",
        '  stat_line="$(cat "/proc/$pid/stat" 2>/dev/null || true)"',
        '  [ -n "$stat_line" ] || return 1',
        '  stat_tail="${stat_line##*) }"',
        '  [ "$stat_tail" != "$stat_line" ] || return 1',
        "  set -- $stat_tail",
        '  [ "$#" -ge 20 ] || return 1',
        '  process_state="$1"',
        '  actual_start="${20}"',
        "}",
        "inspect_identity",
        '[ "$actual_start" = "$expected_start" ]',
        'case "$process_state" in Z|X) exit 1 ;; esac',
        'kill -TERM "$pid"',
      ].join("\n"),
      "sh",
      String(identity.pid),
      identity.startIdentity,
    ],
    {
      artifactName,
      env: probeEnv(),
      timeoutMs: 10_000,
    },
  );
  expect(
    result.exitCode,
    `${artifactName} did not terminate the expected process identity\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  "gateway recovery restores the guard chain and keeps the recovered process identity for 15 seconds (#2478)",
  {
  meta: {
    e2ePhases: [
      "start the compatible endpoint and confirm host readiness",
      "onboard the guarded OpenClaw sandbox",
      "confirm initial gateway and inference health",
      "terminate one live gateway and verify production recovery",
      "verify the recovered process identity remains unchanged for 15 seconds",
    ],
  },
  },
  async ({ artifacts, cleanup, environment, gateway, host, progress, runtime, sandbox }) => {
  await artifacts.target.declare({
    id: "issue-2478-crash-loop-recovery",
    issues: ["#2478", "#2701"],
    unresponsiveRecoveryCycles: 1,
    stabilitySeconds: STABILITY_SECONDS,
    compatibleEndpointModel: COMPATIBLE_MODEL,
  });

  const compatibleEndpoint = await startCompatibleEndpointMock(artifacts);
  cleanup.add("stop issue-2478 compatible endpoint mock", async () => {
    await artifacts.writeJson("compatible-endpoint-mock-requests.json", [
      ...compatibleEndpoint.requests(),
    ]);
    await compatibleEndpoint.close();
  });

  await environment.assertReady(ENVIRONMENT);
  progress.phase("onboard the guarded OpenClaw sandbox");
  const instance = await onboardWithCompatibleEndpoint(
    host,
    cleanup,
    SANDBOX_NAME,
    compatibleEndpoint,
  );
  cleanup.add(`final guard-chain diagnostics ${instance.sandboxName}`, async () => {
    const pid = await gateway.resolveGatewayPid(instance);
    await artifacts.writeJson("final-gateway-pid.json", { pid });
  });

  progress.phase("confirm initial gateway and inference health");
  const initialIdentity = await waitForGatewayIdentity(gateway, instance, 60_000);
  expect(initialIdentity, "gateway should be running after onboard").not.toBeNull();
  await gateway.expectGuardChainActive(instance);
  await runtime.expectInferenceLocalModels(instance, {
    artifactName: "initial-inference-local-models",
    timeoutMs: 60_000,
  });
  const preRecoveryIdentity = await gateway.resolveGatewayIdentity(instance);
    expect(
      preRecoveryIdentity,
      "gateway process identity changed before the recovery probe",
    ).toEqual(initialIdentity);

  progress.phase("terminate one live gateway and verify production recovery");
  await terminateGatewayIdentity(
    sandbox,
    instance.sandboxName,
    preRecoveryIdentity!,
    "functional-recovery-terminate-gateway",
  );
    await runProbeOnly(host, instance.sandboxName, "functional-recovery-connect-probe-only");
  const recoveredIdentity = await waitForGatewayIdentity(gateway, instance, 45_000);
  expect(
    recoveredIdentity,
    "gateway should respawn after the production recovery probe",
  ).not.toBeNull();
  expect(
    `${recoveredIdentity!.pid}:${recoveredIdentity!.startIdentity}`,
    "recovery should replace the terminated gateway process identity",
  ).not.toBe(`${preRecoveryIdentity!.pid}:${preRecoveryIdentity!.startIdentity}`);
  await gateway.expectGuardChainActive(instance);
  await runtime.expectInferenceLocalModels(instance, {
    artifactName: "recovered-inference-local-models",
    timeoutMs: 60_000,
  });

  progress.phase("verify the recovered process identity remains unchanged for 15 seconds");
  const stableIdentity = await gateway.expectPidStable(instance, {
    durationSeconds: STABILITY_SECONDS,
    pollIntervalSeconds: 5,
  });
  expect(stableIdentity).toEqual(recoveredIdentity);
  await artifacts.writeJson("functional-recovery-summary.json", {
    initialIdentity,
    preRecoveryIdentity,
    recoveredIdentity,
    stableIdentity,
    stabilitySeconds: STABILITY_SECONDS,
  });
  },
);
