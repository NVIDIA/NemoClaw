// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-issue-2478-crash-loop-recovery.sh.
 *
 * Preserves the legacy contract with real Docker/OpenShell/NemoClaw boundaries:
 * onboard an OpenClaw sandbox, kill and recover the gateway via the production
 * `connect --probe-only` path, verify the guard-chain preloads remain present,
 * prove inference.local keeps serving models, exercise the missing proxy-env
 * warning path, restore the env file, and soak for crash-loop churn.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-2478";
const CRASH_CYCLES = positiveInteger(process.env.NEMOCLAW_E2E_CRASH_CYCLES, 5);
const SOAK_SECONDS = positiveInteger(process.env.NEMOCLAW_E2E_SOAK_SECONDS, 300);
const COMPATIBLE_MODEL = process.env.NEMOCLAW_COMPAT_MODEL ?? "test-model";
const COMPATIBLE_AUTH_VALUE = ["nemoclaw", "e2e", "compatible", "mock"].join("-");
const ONBOARD_ARGS = [
  "onboard",
  "--non-interactive",
  "--yes",
  "--yes-i-accept-third-party-software",
];

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
  cleanup.add(`destroy NemoClaw sandbox ${sandboxName}`, () => cleanupSandbox(host, sandboxName));

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

async function waitForGatewayPid(
  gateway: {
    resolveGatewayPid(instance: NemoClawInstance): Promise<number | null>;
  },
  instance: NemoClawInstance,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await gateway.resolveGatewayPid(instance);
    if (pid !== null) return pid;
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

async function killGatewayPid(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  pid: number,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    ["sh", "-c", `kill -9 ${pid} 2>/dev/null || true; sleep 1`],
    {
      artifactName,
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(
    result.exitCode,
    `${artifactName}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
}

async function killOpenclawTreeForRecovery(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-c",
      "pkill -9 -f '[o]penclaw' 2>/dev/null || true; sleep 2; pgrep -af '[o]penclaw' || echo ALL_DEAD",
    ],
    { artifactName, env: probeEnv(), timeoutMs: 30_000 },
  );
  expect(result.exitCode, result.stderr).toBe(0);
}

async function snapshotProxyEnv(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
): Promise<{ b64: string; size: number }> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-c",
      "base64 < /tmp/nemoclaw-proxy-env.sh && printf '\\nSIZE=' && wc -c < /tmp/nemoclaw-proxy-env.sh",
    ],
    { artifactName: "snapshot-proxy-env", env: probeEnv(), timeoutMs: 30_000 },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const match = result.stdout.match(/([A-Za-z0-9+/=\n]+)\nSIZE=(\d+)/);
  expect(match, `unexpected proxy-env snapshot output: ${result.stdout}`).not.toBeNull();
  const b64 = match?.[1]?.replace(/\s+/g, "") ?? "";
  const size = Number(match?.[2] ?? 0);
  expect(b64.length, "proxy-env snapshot must not be empty").toBeGreaterThan(0);
  expect(size, "proxy-env snapshot size must be positive").toBeGreaterThan(0);
  return { b64, size };
}

async function removeProxyEnv(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
): Promise<void> {
  const result = await sandbox.exec(sandboxName, ["rm", "-f", "/tmp/nemoclaw-proxy-env.sh"], {
    artifactName: "remove-proxy-env",
    env: probeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
}

async function proxyEnvHasGuardMarkers(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  artifactName: string,
): Promise<boolean> {
  const result = await sandbox.exec(
    sandboxName,
    ["sh", "-c", "cat /tmp/nemoclaw-proxy-env.sh 2>/dev/null || true"],
    { artifactName, env: probeEnv(), timeoutMs: 30_000 },
  );
  return (
    result.stdout.includes("nemoclaw-sandbox-safety-net") &&
    result.stdout.includes("nemoclaw-ciao-network-guard")
  );
}

async function restoreProxyEnv(
  sandbox: {
    exec(
      name: string,
      command: string[],
      options?: Record<string, unknown>,
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  },
  sandboxName: string,
  snapshot: { b64: string; size: number },
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-c",
      `rm -f /tmp/nemoclaw-proxy-env.sh 2>/dev/null || true; (printf '%s' '${snapshot.b64}' | base64 -d > /tmp/nemoclaw-proxy-env.sh 2>/dev/null && chmod 444 /tmp/nemoclaw-proxy-env.sh) || true; wc -c < /tmp/nemoclaw-proxy-env.sh 2>/dev/null || true`,
    ],
    { artifactName: "restore-proxy-env", env: probeEnv(), timeoutMs: 30_000 },
  );
  expect(result.exitCode, result.stderr).toBe(0);

  const restoredSize = Number(result.stdout.trim() || 0);
  if (restoredSize === snapshot.size) return;
  if (await proxyEnvHasGuardMarkers(sandbox, sandboxName, "restore-proxy-env-guard-markers"))
    return;

  expect(restoredSize, "restored proxy-env byte size or recovered guard markers").toBe(
    snapshot.size,
  );
}

async function waitForRecoveryWarning(
  gateway: {
    expectLogContains(
      instance: NemoClawInstance,
      pattern: RegExp,
      options?: Record<string, unknown>,
    ): Promise<void>;
    expectLogDoesNotContain(
      instance: NemoClawInstance,
      pattern: RegExp,
      options?: Record<string, unknown>,
    ): Promise<void>;
  },
  instance: NemoClawInstance,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await gateway.expectLogContains(
        instance,
        /\[gateway-recovery\] WARNING: .*restoring library guards from packaged preloads/,
        { lines: 200 },
      );
      await gateway.expectLogDoesNotContain(instance, /gateway launching without library guards/, {
        lines: 200,
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(3_000);
    }
  }
  throw lastError;
}

async function sampleGatewayStability(
  gateway: {
    resolveGatewayPid(instance: NemoClawInstance): Promise<number | null>;
  },
  runtime: {
    expectInferenceLocalModels(
      instance: NemoClawInstance,
      options?: Record<string, unknown>,
    ): Promise<unknown>;
  },
  instance: NemoClawInstance,
  soakSeconds: number,
): Promise<{
  samples: Array<number | null>;
  inferenceFailures: number;
  inferenceProbes: number;
}> {
  const samples: Array<number | null> = [];
  let inferenceFailures = 0;
  let inferenceProbes = 0;
  const intervalSeconds = 15;

  for (let elapsed = 0; elapsed < soakSeconds; elapsed += intervalSeconds) {
    samples.push(await gateway.resolveGatewayPid(instance));
    if (elapsed % 60 === 0) {
      inferenceProbes += 1;
      try {
        await runtime.expectInferenceLocalModels(instance, {
          artifactName: `soak-inference-local-models-${elapsed}s`,
          curlMaxTimeSeconds: 5,
          timeoutMs: 15_000,
        });
      } catch {
        inferenceFailures += 1;
      }
    }
    await sleep(intervalSeconds * 1_000);
  }

  return { samples, inferenceFailures, inferenceProbes };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("issue-2478: gateway recovery preserves guard chain and avoids crash loop", async ({
  artifacts,
  cleanup,
  environment,
  gateway,
  host,
  runtime,
  sandbox,
}) => {
  await artifacts.writeJson("scenario.json", {
    id: "issue-2478-crash-loop-recovery",
    legacyScript: "test/e2e/test-issue-2478-crash-loop-recovery.sh",
    issues: ["#2478", "#2701"],
    crashCycles: CRASH_CYCLES,
    soakSeconds: SOAK_SECONDS,
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

  const initialPid = await waitForGatewayPid(gateway, instance, 60_000);
  expect(initialPid, "gateway should be running after onboard").not.toBeNull();
  await gateway.expectGuardChainActive(instance);
  await runtime.expectInferenceLocalModels(instance, {
    artifactName: "initial-inference-local-models",
    timeoutMs: 60_000,
  });

  let previousPid = initialPid!;
  for (let cycle = 1; cycle <= CRASH_CYCLES; cycle += 1) {
    await killGatewayPid(sandbox, instance.sandboxName, previousPid, `cycle-${cycle}-kill-gateway`);
    await runProbeOnly(host, instance.sandboxName, `cycle-${cycle}-connect-probe-only`);
    const nextPid = await waitForGatewayPid(gateway, instance, 45_000);
    expect(nextPid, `cycle ${cycle}: gateway should respawn`).not.toBeNull();
    expect(nextPid, `cycle ${cycle}: kill should force a new PID`).not.toBe(previousPid);
    await gateway.expectGuardChainActive(instance);
    await runtime.expectInferenceLocalModels(instance, {
      artifactName: `cycle-${cycle}-inference-local-models`,
      timeoutMs: 60_000,
    });
    previousPid = nextPid!;
  }

  const snapshot = await snapshotProxyEnv(sandbox, instance.sandboxName);
  await removeProxyEnv(sandbox, instance.sandboxName);
  await killOpenclawTreeForRecovery(
    sandbox,
    instance.sandboxName,
    "missing-proxy-env-kill-gateway-tree",
  );
  await runProbeOnly(host, instance.sandboxName, "missing-proxy-env-connect-probe-only");
  await waitForRecoveryWarning(gateway, instance);
  const negativePid = await waitForGatewayPid(gateway, instance, 45_000);
  expect(negativePid, "missing proxy-env warning path should still respawn gateway").not.toBeNull();
  await gateway.expectGuardChainActive(instance);

  await restoreProxyEnv(sandbox, instance.sandboxName, snapshot);
  await killOpenclawTreeForRecovery(
    sandbox,
    instance.sandboxName,
    "restored-proxy-env-kill-gateway-tree",
  );
  await runProbeOnly(host, instance.sandboxName, "restored-proxy-env-connect-probe-only");
  const soakStartPid = await waitForGatewayPid(gateway, instance, 45_000);
  expect(soakStartPid, "gateway should be up before soak").not.toBeNull();
  await gateway.expectGuardChainActive(instance);
  await runtime.expectInferenceLocalModels(instance, {
    artifactName: "pre-soak-inference-local-models",
    timeoutMs: 60_000,
  });

  const soak = await sampleGatewayStability(gateway, runtime, instance, SOAK_SECONDS);
  await artifacts.writeJson("soak-summary.json", soak);
  const distinctPids = new Set(soak.samples.filter((pid): pid is number => pid !== null));
  const emptySamples = soak.samples.filter((pid) => pid === null).length;

  expect(
    distinctPids.size,
    `crash-loop signature: ${distinctPids.size} distinct PIDs in samples ${soak.samples.join(",")}`,
  ).toBeLessThanOrEqual(2);
  expect(
    emptySamples,
    `gateway should not disappear repeatedly during soak: ${soak.samples.join(",")}`,
  ).toBeLessThanOrEqual(1);
  expect(soak.inferenceFailures, "inference.local should stay available during soak").toBe(0);
});
