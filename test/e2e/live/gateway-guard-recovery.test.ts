// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live E2E: gateway guard-chain recovery after pod-recreate /tmp wipe.
 *
 * Regression guard for NVIDIA/NemoClaw#2701. The historical recovery shell
 * took a "warn-and-proceed" branch when `/tmp/nemoclaw-proxy-env.sh` was
 * missing: it logged `[gateway-recovery] WARNING` and launched the gateway
 * naked. On
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
 *     checkAndRecoverSandboxProcesses() → authenticated PID 1 supervisor)
 *     after the pod-recreate-equivalent state
 *     of an empty guard-chain `/tmp` plus no running gateway process. This
 *     proves the user no longer needs `nemoclaw <sandbox> rebuild --yes` for
 *     that recovered runtime state.
 *   - Deliberately out of scope for this merge gate: physical DGX Spark /
 *     GB10 / aarch64 hardware, provider breadth beyond `cloud-openclaw`, and
 *     destructive host reboot / OOM / manual `kubectl delete pod` triggers.
 *     The Docker-driver branch below does restart the registered sandbox
 *     container, then proves the legacy keepalive migration restores the
 *     managed supervisor topology without relying on ordinary sandbox exec.
 *     Kubernetes triggers still need a dedicated platform-runtime job.
 *
 * This Vitest coverage owns both the #2478 WARNING assertion lineage and the
 * #2701 guard-chain assertion.
 */

import { containsInteger42Answer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { ubuntuRepoDocker } from "../registry/matrix.ts";

// Reuses the standard ubuntu-repo-docker environment with the
// `cloud-openclaw` onboarding profile (the only one the framework's
// OnboardingPhaseFixture currently supports per
// `test/e2e/registry/runtime-support.ts:SUPPORTED_ONBOARDING`).
// We don't route through the typed target registry because the registry
// is keyed on steady-state expected-state probes (cli-installed,
// gateway-healthy, ...); recovery targets are behavioral and don't fit
// that mold.
const ENVIRONMENT = ubuntuRepoDocker("cloud-openclaw");

const SANDBOX_NAME = "e2e-2701";

const STARTUP_COMMAND_INSPECT_SCRIPT = String.raw`
const { spawnSync } = require("node:child_process");
const id = process.argv[1];
const result = spawnSync("docker", ["inspect", "--type", "container", id], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || "docker inspect failed\n");
  process.exit(result.status || 1);
}
const rows = JSON.parse(result.stdout);
const prefix = "OPENSHELL_SANDBOX_COMMAND=";
const matches = (rows[0]?.Config?.Env || []).filter((entry) => entry.startsWith(prefix));
if (matches.length !== 1) {
  process.stderr.write("expected one OpenShell sandbox startup command\n");
  process.exit(1);
}
process.stdout.write(matches[0].slice(prefix.length) + "\n");
`;

const SUPERVISOR_TOPOLOGY_SCRIPT = String.raw`from pathlib import Path
import pwd
expected_uid=str(pwd.getpwnam("sandbox").pw_uid)
assert expected_uid != "0", expected_uid
rows=[]
for entry in Path("/proc").iterdir():
    if not entry.name.isdigit() or entry.name == "1":
        continue
    try:
        stat=(entry / "stat").read_text().rsplit(")", 1)[1].split()
        cmd=(entry / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
        status=(entry / "status").read_text()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if int(stat[1]) != 1 or not cmd:
        continue
    if cmd[0].rsplit(b"/", 1)[-1] == b"nemoclaw-start" or (len(cmd) > 1 and cmd[0].rsplit(b"/", 1)[-1] == b"bash" and cmd[1].rsplit(b"/", 1)[-1] == b"nemoclaw-start"):
        rows.append((entry.name, status))
assert len(rows) == 1, rows
uid_line=next(line for line in rows[0][1].splitlines() if line.startswith("Uid:"))
assert uid_line.split()[1:] == [expected_uid] * 4, uid_line
print("MANAGED_SUPERVISOR=" + rows[0][0] + ":PPID1")`;

async function findSandboxContainer(host: HostCliClient, artifactName: string): Promise<string> {
  const result = await host.command(
    "docker",
    [
      "ps",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
      "--format",
      "{{.ID}}",
    ],
    { artifactName, env: buildAvailabilityProbeEnv() },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
  expect(ids, resultText(result)).toHaveLength(1);
  return ids[0] ?? "";
}

async function inspectStartupCommand(
  host: HostCliClient,
  containerId: string,
  artifactName: string,
): Promise<string> {
  const result = await host.command("node", ["-e", STARTUP_COMMAND_INSPECT_SCRIPT, containerId], {
    artifactName,
    env: buildAvailabilityProbeEnv(),
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result.stdout.trim();
}

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
  secrets.required("NVIDIA_INFERENCE_API_KEY");

  await artifacts.target.declare({
    id: "gateway-guard-recovery",
    boundary: "sandbox-lifecycle",
    issues: ["#2701", "#2478", "#6635"],
    acceptanceCoverage: {
      covered: [
        "production connect --probe-only recovery route",
        "authenticated PID 1 OpenClaw recovery supervisor",
        "pod-recreate-equivalent empty /tmp guard chain plus missing gateway process",
        "Docker container restart with a legacy keepalive startup",
        "container-identity-pinned supervisor recreation with managed health proof",
        "no rebuild required for the recovered runtime state",
      ],
      intentionallyOutOfScope: [
        "DGX Spark / GB10 / aarch64 hardware matrix",
        "provider breadth beyond cloud-openclaw",
        "host reboot / OOM / manual kubectl delete pod triggers",
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
    // ShellProbe accepts only explicit env; without one the spawned
    // `nemoclaw` (= `node bin/nemoclaw.js`) cannot find node
    // on PATH and exits 127. Pass the framework's allowlisted env so PATH,
    // HOME, and the OPENSHELL_GATEWAY override flow through.
    env: {
      ...buildAvailabilityProbeEnv(),
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    },
    timeoutMs: 180_000,
  });
  cleanup.add(`recovery-result-${instance.sandboxName}`, async () => {
    await artifacts.writeJson("recovery-result.json", {
      exitCode: recoveryResult.exitCode,
    });
  });
  // Capture PID 1 and gateway evidence before the exit-code assertion can
  // abort the scenario and cleanup destroys the sandbox.
  const recoveryDiagnostics = await sandbox.exec(
    instance.sandboxName,
    [
      "sh",
      "-c",
      "printf '%s\\n' '== entrypoint log ==' ; " +
        "tail -n 300 /tmp/nemoclaw-start.log 2>&1 || true; " +
        "printf '%s\\n' '== gateway log ==' ; " +
        "tail -n 300 /tmp/gateway.log 2>&1 || true; " +
        "printf '%s\\n' '== direct gateway health ==' ; " +
        "curl -so /dev/null -w 'HTTP %{http_code}\\n' --max-time 3 http://127.0.0.1:18789/health 2>&1 || true; " +
        "printf '%s\\n' '== gateway pid record ==' ; " +
        "cat /tmp/nemoclaw-gateway.pid 2>&1 || true; " +
        "printf '%s\\n' '== supervisor status ==' ; " +
        "cat /run/nemoclaw/gateway-control/status 2>&1 || true",
    ],
    {
      artifactName: "gateway-recovery-diagnostics",
      env: {
        ...buildAvailabilityProbeEnv(),
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
      },
    },
  );
  expect(
    recoveryResult.exitCode,
    `connect --probe-only recovery failed\nstdout:\n${recoveryResult.stdout}\nstderr:\n${recoveryResult.stderr}`,
  ).toBe(0);

  // ── Assert #2701 contract ────────────────────────────────────────
  // After recovery completes, the guard chain MUST be restored. Before the
  // fix, recovery emitted a WARNING but launched the gateway naked, leaving
  // /tmp/nemoclaw-proxy-env.sh absent. After the fix lands, recovery re-emits
  // the chain before launching.
  await gateway.expectGuardChainActive(instance);

  // A missing proxy-env file is still worth surfacing, but the warning must
  // describe trusted restoration instead of an unguarded launch.
  expect(recoveryDiagnostics.stdout).toMatch(/restoring library guards from packaged preloads/);
  expect(recoveryDiagnostics.stdout).not.toMatch(/gateway launching without library guards/);

  // Gateway must be steady-state — no crash loop. This assertion is
  // the "would have caught DGX Spark" check, even on x86 runners,
  // because a naked gateway crash would also flake on x86 occasionally
  // and a fix that restores the chain trivially holds the PID.
  const stablePid = await gateway.expectPidStable(instance, {
    durationSeconds: 30,
    pollIntervalSeconds: 5,
  });

  expect(stablePid).toBeGreaterThan(0);

  // ── Assert #6635 legacy Docker restart recovery ────────────────
  // Fresh non-GPU OpenClaw containers on this OpenShell floor still carry the
  // legacy keepalive. Restarting the container therefore kills the initial
  // OpenShell workload session and deterministically leaves no managed
  // supervisor. Recovery must upgrade that container through the host-side
  // transaction and commit only after managed control accepts the new tree.
  const originalContainerId = await findSandboxContainer(host, "legacy-restart-container-before");
  expect(
    await inspectStartupCommand(host, originalContainerId, "legacy-restart-command-before"),
  ).toBe("sleep infinity");
  await host.cleanupForward(18789, {
    artifactName: "legacy-restart-stop-dashboard-forward",
    env: buildAvailabilityProbeEnv(),
  });
  const restart = await host.command("docker", ["restart", originalContainerId], {
    artifactName: "legacy-restart-docker-restart",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 120_000,
  });
  expect(restart.exitCode, resultText(restart)).toBe(0);

  const credentialCanary = "nemoclaw-e2e-recovery-secret-6635";
  const trustedRecovery = await host.nemoclaw([instance.sandboxName, "recover"], {
    artifactName: "legacy-restart-trusted-recover",
    env: {
      ...buildAvailabilityProbeEnv(),
      NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "CUSTOM_PROVIDER_CREDENTIAL",
      CUSTOM_PROVIDER_CREDENTIAL: credentialCanary,
    },
    redactionValues: [credentialCanary],
    timeoutMs: 240_000,
  });
  expect(trustedRecovery.timedOut, resultText(trustedRecovery)).toBe(false);
  expect(trustedRecovery.exitCode, resultText(trustedRecovery)).toBe(0);
  expect(resultText(trustedRecovery)).toContain("Probe complete: recovered OpenClaw gateway");

  const recoveredContainerId = await findSandboxContainer(host, "legacy-restart-container-after");
  expect(recoveredContainerId).not.toBe(originalContainerId);
  const recoveredStartupCommand = await inspectStartupCommand(
    host,
    recoveredContainerId,
    "legacy-restart-command-after",
  );
  expect(recoveredStartupCommand).toMatch(/(?:^| )nemoclaw-start$/);
  expect(recoveredStartupCommand).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
  expect(recoveredStartupCommand).not.toContain(credentialCanary);

  const topology = await sandbox.exec(
    instance.sandboxName,
    ["python3", "-c", SUPERVISOR_TOPOLOGY_SCRIPT],
    {
      artifactName: "legacy-restart-managed-supervisor-topology",
      env: buildAvailabilityProbeEnv(),
    },
  );
  expect(topology.exitCode, resultText(topology)).toBe(0);
  expect(topology.stdout).toMatch(/MANAGED_SUPERVISOR=[0-9]+:PPID1/);

  const forwardedHealth = await host.command(
    "curl",
    ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18789/health"],
    {
      artifactName: "legacy-restart-forwarded-health",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(forwardedHealth.exitCode, resultText(forwardedHealth)).toBe(0);
  expect(forwardedHealth.stdout.trim()).toMatch(/^(200|401)$/);

  const inference = await host.nemoclaw(
    [
      instance.sandboxName,
      "agent",
      "--agent",
      "main",
      "--json",
      "--session-id",
      `e2e-6635-${Date.now()}-${process.pid}`,
      "-m",
      "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
    ],
    {
      artifactName: "legacy-restart-agent-inference",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    },
  );
  expect(inference.exitCode, resultText(inference)).toBe(0);
  expect(containsInteger42Answer(inference.stdout), resultText(inference)).toBe(true);
});
