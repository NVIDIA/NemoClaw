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

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/onboarding.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-2478";
const CRASH_CYCLES = positiveInteger(process.env.NEMOCLAW_E2E_CRASH_CYCLES, 5);
const SOAK_SECONDS = positiveInteger(process.env.NEMOCLAW_E2E_SOAK_SECONDS, 300);

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

async function waitForGatewayPid(
  gateway: { resolveGatewayPid(instance: NemoClawInstance): Promise<number | null> },
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
  host: { nemoclaw(args?: string[], options?: Record<string, unknown>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> },
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
  sandbox: { exec(name: string, command: string[], options?: Record<string, unknown>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> },
  sandboxName: string,
  pid: number,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.exec(sandboxName, ["sh", "-c", `kill -9 ${pid} 2>/dev/null; sleep 1`], {
    artifactName,
    env: probeEnv(),
    timeoutMs: 30_000,
  });
  expect(result.exitCode, `${artifactName}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

async function snapshotProxyEnv(
  sandbox: { exec(name: string, command: string[], options?: Record<string, unknown>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> },
  sandboxName: string,
): Promise<{ b64: string; size: number }> {
  const result = await sandbox.exec(
    sandboxName,
    ["sh", "-c", "base64 < /tmp/nemoclaw-proxy-env.sh && printf '\\nSIZE=' && wc -c < /tmp/nemoclaw-proxy-env.sh"],
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

async function restoreProxyEnv(
  sandbox: { exec(name: string, command: string[], options?: Record<string, unknown>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> },
  sandboxName: string,
  snapshot: { b64: string; size: number },
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    [
      "sh",
      "-c",
      `echo '${snapshot.b64}' | base64 -d > /tmp/nemoclaw-proxy-env.sh && chmod 444 /tmp/nemoclaw-proxy-env.sh && wc -c < /tmp/nemoclaw-proxy-env.sh`,
    ],
    { artifactName: "restore-proxy-env", env: probeEnv(), timeoutMs: 30_000 },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  expect(Number(result.stdout.trim()), "restored proxy-env byte size").toBe(snapshot.size);
}

async function waitForRecoveryWarning(
  gateway: { expectLogContains(instance: NemoClawInstance, pattern: RegExp, options?: Record<string, unknown>): Promise<void> },
  instance: NemoClawInstance,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await gateway.expectLogContains(instance, /\[gateway-recovery\] WARNING/, { lines: 100 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(3_000);
    }
  }
  throw lastError;
}

async function sampleGatewayStability(
  gateway: { resolveGatewayPid(instance: NemoClawInstance): Promise<number | null> },
  runtime: { expectInferenceLocalModels(instance: NemoClawInstance, options?: Record<string, unknown>): Promise<unknown> },
  instance: NemoClawInstance,
  soakSeconds: number,
): Promise<{ samples: Array<number | null>; inferenceFailures: number; inferenceProbes: number }> {
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
  onboard,
  runtime,
  sandbox,
  secrets,
}) => {
  secrets.required("NVIDIA_API_KEY");

  await artifacts.writeJson("scenario.json", {
    id: "issue-2478-crash-loop-recovery",
    legacyScript: "test/e2e/test-issue-2478-crash-loop-recovery.sh",
    issues: ["#2478", "#2701"],
    crashCycles: CRASH_CYCLES,
    soakSeconds: SOAK_SECONDS,
  });

  const ready = await environment.assertReady(ENVIRONMENT);
  const instance = await onboard.from(ready, { sandboxName: SANDBOX_NAME });
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
  await sandbox.wipeGuardChain(instance.sandboxName);
  await sandbox.killGatewayTree(instance.sandboxName);
  await runProbeOnly(host, instance.sandboxName, "missing-proxy-env-connect-probe-only");
  await waitForRecoveryWarning(gateway, instance);
  const negativePid = await waitForGatewayPid(gateway, instance, 45_000);
  expect(negativePid, "missing proxy-env warning path should still respawn gateway").not.toBeNull();

  // #2701 follow-on contract from the legacy script: after the recovery fix,
  // missing /tmp guard files are re-emitted instead of leaving the gateway naked.
  await gateway.expectGuardChainActive(instance);

  await restoreProxyEnv(sandbox, instance.sandboxName, snapshot);
  await sandbox.killGatewayTree(instance.sandboxName);
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
  expect(emptySamples, `gateway should not disappear repeatedly during soak: ${soak.samples.join(",")}`).toBeLessThanOrEqual(1);
  expect(soak.inferenceFailures, "inference.local should stay available during soak").toBe(0);
});
