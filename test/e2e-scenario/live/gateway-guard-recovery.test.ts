// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live E2E: gateway guard-chain recovery after pod-recreate /tmp wipe.
 *
 * Failing-test-first regression guard for NVIDIA/NemoClaw#2701. On `main` at
 * the time this test landed, `buildOpenClawRecoveryScript()` takes a
 * "warn-and-proceed" branch when `/tmp/nemoclaw-proxy-env.sh` is missing —
 * it logs `[gateway-recovery] WARNING` and launches the gateway naked. On
 * aarch64 / DGX Spark this triggers an infinite crash loop in
 * `@homebridge/ciao` (`os.networkInterfaces()` throws because the OpenShell
 * netns blocks the syscall). The only manual recovery is a 5-min
 * `nemoclaw <name> rebuild --yes`.
 *
 * This test asserts the desired contract — recovery RESTORES the guard
 * chain before launching, no WARNING line, gateway PID stable. It will fail
 * on `main` (proving the bug), pass once the fix lands.
 *
 * The contract is platform-independent: we don't need aarch64 to assert
 * "guards are present after recovery." The aarch64 ciao crash is a
 * downstream consequence of the same broken contract.
 *
 * The corresponding legacy bash phase remains in
 * `test/e2e/test-issue-2478-crash-loop-recovery.sh` Phase 4 with both the
 * #2478 WARNING assertion (current contract) and the new #2701 guard-chain
 * assertion (failing today, green after fix).
 */

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { ubuntuRepoDocker } from "../scenarios/matrix.ts";

// Reuses the standard ubuntu-repo-docker environment with the
// `cloud-openclaw` onboarding profile (the only one the framework's
// OnboardingPhaseFixture currently supports per
// `test/e2e-scenario/scenarios/runtime-support.ts:SUPPORTED_ONBOARDING`).
// We don't route through the typed scenario registry because the registry
// is keyed on steady-state expected-state probes (cli-installed,
// gateway-healthy, ...); recovery scenarios are behavioral and don't fit
// that mold.
const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");

const SANDBOX_NAME = "e2e-2701";

test("gateway recovery restores /tmp guard chain after pod-recreate wipe (#2701)", async ({
  artifacts,
  environment,
  onboard,
  host,
  gateway,
  sandbox,
  secrets,
  cleanup,
}) => {
  secrets.required("NVIDIA_API_KEY");

  await artifacts.writeJson("scenario.json", {
    id: "gateway-guard-recovery",
    runner: "vitest",
    boundary: "sandbox-lifecycle",
    issues: ["#2701", "#2478"],
  });

  // ── Setup ────────────────────────────────────────────────────────
  const ready = await environment.assertReady(ENVIRONMENT);
  const instance = await onboard.from(ready, { sandboxName: SANDBOX_NAME });

  // Baseline: a freshly-onboarded sandbox must already have the guard
  // chain wired. If this fails, the bug isn't #2701 — it's a regression of
  // the entrypoint guard install path.
  await gateway.expectGuardChainActive(instance);

  // ── Disrupt ──────────────────────────────────────────────────────
  // Same shape as a fresh container after pod recreate: /tmp is empty of
  // the guard chain, and the openclaw process tree is gone.
  await sandbox.wipeGuardChain(instance.sandboxName);
  await sandbox.killGatewayTree(instance.sandboxName);

  // ── Trigger recovery ─────────────────────────────────────────────
  // `connect --probe-only` invokes checkAndRecoverSandboxProcesses(),
  // which is the production code path that runs every time a user
  // reconnects to a sandbox. This is the failure surface end-users hit
  // after a host reboot on DGX Spark.
  const recoveryResult = await host.nemoclaw([instance.sandboxName, "connect", "--probe-only"], {
    artifactName: "nemoclaw-connect-probe-only",
    // ShellProbe defaults to inheritEnv: false; without an explicit env
    // the spawned `nemoclaw` (= `node bin/nemoclaw.js`) cannot find node
    // on PATH and exits 127. Pass the framework's allowlisted env so PATH,
    // HOME, and the OPENSHELL_GATEWAY override flow through.
    env: {
      ...buildAvailabilityProbeEnv(),
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    },
    timeoutMs: 90_000,
  });
  cleanup.add(`recovery-result-${instance.sandboxName}`, async () => {
    await artifacts.writeJson("recovery-result.json", {
      exitCode: recoveryResult.exitCode,
    });
  });

  // ── Assert #2701 contract ────────────────────────────────────────
  // After recovery completes, the guard chain MUST be restored. Today
  // this fails: recovery emits a WARNING but launches the gateway
  // naked, leaving /tmp/nemoclaw-proxy-env.sh absent. After the fix
  // lands, recovery re-emits the chain before launching.
  await gateway.expectGuardChainActive(instance);

  // No WARNING line should appear in the gateway log — the fix turns
  // the warn-and-proceed branch into a re-emit-and-continue branch.
  await gateway.expectLogDoesNotContain(instance, /\[gateway-recovery\] WARNING/);

  // Gateway must be steady-state — no crash loop. This assertion is
  // the "would have caught DGX Spark" check, even on x86 runners,
  // because a naked gateway crash would also flake on x86 occasionally
  // and a fix that restores the chain trivially holds the PID.
  const stablePid = await gateway.expectPidStable(instance, {
    durationSeconds: 30,
    pollIntervalSeconds: 5,
  });

  expect(stablePid).toBeGreaterThan(0);
});
