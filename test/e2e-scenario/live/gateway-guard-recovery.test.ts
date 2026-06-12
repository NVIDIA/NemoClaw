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
 * This test asserts the desired contract — recovery logs that it is restoring
 * from trusted packaged preloads, RESTORES the guard chain before launching,
 * and keeps the gateway PID stable. It will fail on `main` (proving the bug),
 * pass once the fix lands.
 *
 * The contract is platform-independent: we don't need aarch64 to assert
 * "guards are present after recovery." The aarch64 ciao crash is a
 * downstream consequence of the same broken contract.
 *
 * #2701 acceptance scope for this PR:
 *   - Covered: the default OpenClaw production recovery route
 *     (`nemoclaw <sandbox> connect --probe-only` →
 *     checkAndRecoverSandboxProcesses() → `openshell sandbox exec -- sh -c`
 *     buildOpenClawRecoveryScript()) after the pod-recreate-equivalent state
 *     of an empty guard-chain `/tmp` plus no running gateway process. This
 *     proves the user no longer needs `nemoclaw <sandbox> rebuild --yes` for
 *     that recovered runtime state.
 *   - Deliberately out of scope for this merge gate: physical DGX Spark /
 *     GB10 / aarch64 hardware, provider breadth beyond `cloud-openclaw`, and
 *     destructive host reboot / OOM / supervisor crash / manual
 *     `kubectl delete pod` triggers. The current live Vitest runner exposes a
 *     Docker-driver OpenShell sandbox and does not provide a stable per-test
 *     Kubernetes pod handle that can be deleted without destabilizing shared
 *     gateway state. Those trigger/hardware/provider clauses need a dedicated
 *     platform-runtime job; this test locks down the shared recovery contract
 *     they all depend on.
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
    acceptanceCoverage: {
      covered: [
        "production connect --probe-only recovery route",
        "openshell sandbox exec -- sh -c OpenClaw recovery script",
        "pod-recreate-equivalent empty /tmp guard chain plus missing gateway process",
        "no rebuild required for the recovered runtime state",
      ],
      intentionallyOutOfScope: [
        "DGX Spark / GB10 / aarch64 hardware matrix",
        "provider breadth beyond cloud-openclaw",
        "host reboot / OOM / supervisor crash / manual kubectl delete pod triggers",
      ],
    },
  });

  // ── Setup ────────────────────────────────────────────────────────
  const ready = await environment.assertReady(ENVIRONMENT);
  const instance = await onboard.from(ready, { sandboxName: SANDBOX_NAME });

  // Baseline: a freshly-onboarded sandbox must already have the guard
  // chain wired. If this fails, the bug isn't #2701 — it's a regression of
  // the entrypoint guard install path.
  await gateway.expectGuardChainActive(instance);

  // ── Disrupt ──────────────────────────────────────────────────────
  // Deterministic pod-recreate-equivalent state: /tmp is empty of the guard
  // chain, and the OpenClaw process tree is gone. This avoids coupling the
  // merge gate to a host-specific pod/container delete primitive while still
  // exercising the production sandbox-exec recovery route below.
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
  // After recovery completes, the guard chain MUST be restored. Before the
  // fix, recovery emitted a WARNING but launched the gateway naked, leaving
  // /tmp/nemoclaw-proxy-env.sh absent. After the fix lands, recovery re-emits
  // the chain before launching.
  await gateway.expectGuardChainActive(instance);

  // A missing proxy-env file is still worth surfacing, but the warning must
  // describe trusted restoration instead of an unguarded launch.
  await gateway.expectLogContains(instance, /restoring library guards from packaged preloads/);
  await gateway.expectLogDoesNotContain(instance, /gateway launching without library guards/);

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
