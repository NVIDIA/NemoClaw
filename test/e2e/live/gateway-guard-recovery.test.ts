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
 *     The Docker-driver branch below first restarts the registered sandbox
 *     container with its persisted startup command, then recreates the legacy
 *     keepalive state and proves both routes restore the managed supervisor
 *     topology without relying on ordinary sandbox exec.
 *     Kubernetes triggers still need a dedicated platform-runtime job.
 *
 * This Vitest coverage owns both the #2478 WARNING assertion lineage and the
 * #2701 guard-chain assertion.
 */

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { pollUntil } from "../fixtures/polling.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { ubuntuRepoDocker } from "../registry/matrix.ts";
import { parseLegacyKeepaliveHandoffReceipt } from "./gateway-guard-legacy-keepalive-fixture.ts";

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
const LEGACY_KEEPALIVE_FIXTURE = fileURLToPath(
  new URL("./gateway-guard-legacy-keepalive-fixture.ts", import.meta.url),
);

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

const OPENCLAW_STATE_LOCK_PLAN_PROBE = String.raw`import json, os
path="/usr/local/share/nemoclaw/state-lock-plan.json"
metadata=os.stat(path, follow_symlinks=False)
assert metadata.st_uid == 0 and metadata.st_gid == 0, metadata
assert metadata.st_mode & 0o022 == 0, oct(metadata.st_mode)
plan=json.load(open(path, encoding="utf-8"))
assert "workspace" in plan["readOnlyRoots"], plan
assert "workspace-" in plan["readOnlyPrefixes"], plan
print("OPENCLAW_STATE_LOCK_PLAN=installed")`;

const CONTAINER_GATEWAY_PROCESS_STATE_SCRIPT = String.raw`from pathlib import Path
import pwd, sys
pid=sys.argv[1]
assert pid.isascii() and pid.isdigit() and int(pid) > 1, pid
process=Path("/proc") / pid
stat=(process / "stat").read_text().rsplit(")", 1)[1].split()
cmdline=(process / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
status=(process / "status").read_text()
assert cmdline, pid
parent_pid=stat[1]
parent_cmdline=(Path("/proc") / parent_pid / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
assert parent_cmdline, parent_pid
expected_uid=str(pwd.getpwnam("sandbox").pw_uid)
assert expected_uid != "0", expected_uid
uid_line=next(line for line in status.splitlines() if line.startswith("Uid:"))
assert uid_line.split()[1:] == [expected_uid] * 4, uid_line
gateway_command=cmdline[0].rsplit(b"/", 1)[-1].decode("ascii", "strict")
parent_command=parent_cmdline[0].rsplit(b"/", 1)[-1]
if parent_command == b"bash" and len(parent_cmdline) > 1:
    parent_command=parent_cmdline[1].rsplit(b"/", 1)[-1]
assert parent_command == b"nemoclaw-start", parent_command
print(f"GATEWAY_PROCESS={pid}:PPID={parent_pid}:UID={expected_uid}:COMMAND={gateway_command}:PARENT=nemoclaw-start")`;

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

async function captureManagedGatewayState(
  host: HostCliClient,
  containerId: string,
  artifactPrefix: string,
) {
  const nonce = randomBytes(32).toString("hex");
  const managedControl = await host.command(
    "docker",
    [
      "exec",
      "--env",
      "LD_PRELOAD=",
      "--env",
      "PYTHONPATH=",
      "--user",
      "root",
      containerId,
      "/usr/local/bin/nemoclaw-gateway-control",
      "probe",
      nonce,
    ],
    {
      artifactName: `${artifactPrefix}-managed-control-after-recovery`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const gatewayPid =
    managedControl.stdout.match(/\r?\nGATEWAY_PID=([1-9][0-9]*)\r?\n?$/)?.[1] ?? "invalid";
  const processState = await host.command(
    "docker",
    [
      "exec",
      "--env",
      "LD_PRELOAD=",
      "--env",
      "PYTHONPATH=",
      "--user",
      "root",
      containerId,
      "python3",
      "-I",
      "-c",
      CONTAINER_GATEWAY_PROCESS_STATE_SCRIPT,
      gatewayPid,
    ],
    {
      artifactName: `${artifactPrefix}-process-state-after-recovery`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  return { managedControl, nonce, processState };
}

function expectManagedGatewayState(
  state: Awaited<ReturnType<typeof captureManagedGatewayState>>,
): void {
  expect(
    state.managedControl.timedOut,
    "managed control probe should complete before timeout",
  ).toBe(false);
  expect(state.managedControl.exitCode, "managed control probe should exit successfully").toBe(0);
  expect(state.managedControl.stderr, "managed control probe should keep stderr empty").toBe("");
  const controlProof = state.managedControl.stdout.match(
    /^v1 ([0-9a-f]{64}) complete already-running ([1-9][0-9]*) \2\r?\nGATEWAY_PID=\2\r?\n?$/,
  );
  expect(
    controlProof?.[1] === state.nonce,
    "managed control should return the nonce-bound running proof",
  ).toBe(true);
  const gatewayPid = controlProof?.[2];
  expect(
    /^[1-9][0-9]*$/.test(gatewayPid ?? ""),
    "managed control should report the gateway PID",
  ).toBe(true);
  expect(state.processState.timedOut, "process-state probe should complete before timeout").toBe(
    false,
  );
  expect(state.processState.exitCode, "process-state probe should exit successfully").toBe(0);
  expect(state.processState.stderr, "process-state probe should keep stderr empty").toBe("");
  expect(
    new RegExp(
      `^GATEWAY_PROCESS=${gatewayPid}:PPID=[1-9][0-9]*:UID=[1-9][0-9]*:COMMAND=[A-Za-z0-9._+-]+:PARENT=nemoclaw-start\\r?\\n?$`,
    ).test(state.processState.stdout),
    "the container process table should include the controller-reported gateway PID under the managed supervisor",
  ).toBe(true);
}

async function waitForSandboxExecReady(
  host: HostCliClient,
  sandboxName: string,
  progress: TestProgress,
  artifactPrefix: string,
): Promise<void> {
  await pollUntil({
    artifactPrefix,
    attempts: 12,
    delayMs: 3_000,
    probe: async (_attempt, artifactName) =>
      await host.command(
        host.openshellCommandPath,
        ["sandbox", "exec", "-n", sandboxName, "--", "true"],
        {
          artifactName,
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      ),
    accept: (result, attempt) =>
      result.exitCode === 0 ? true : reportReadinessRetry(progress, attempt),
  });
}

function reportReadinessRetry(progress: TestProgress, attempt: number): false {
  progress.event(`OpenShell sandbox readiness retry ${attempt}`);
  return false;
}

test(
  "gateway recovery restores /tmp guard chain after pod-recreate wipe (#2701)",
  {
    meta: {
      e2ePhases: [
        "onboard guarded OpenClaw sandbox",
        "verify initial gateway guard chain",
        "wipe guard chain and gateway tree",
        "recover gateway through connect probe",
        "validate recovered guard and stable PID",
        "restart sandbox container with persisted startup command",
        "recover managed supervisor and inference",
        "recreate and restart sandbox container with legacy keepalive",
        "recover legacy managed supervisor and inference",
      ],
    },
  },
  async ({
    artifacts,
    environment,
    onboard,
    host,
    gateway,
    progress,
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
          "Docker container restart with a persisted managed startup command",
          "container identity preservation with managed supervisor health proof",
          "Docker container recreation with the legacy keepalive startup command",
          "container-identity-pinned legacy supervisor migration with managed health proof",
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

    progress.phase("verify initial gateway guard chain");
    // Baseline: a freshly-onboarded sandbox must already have the guard
    // chain wired. If this fails, the bug isn't #2701 — it's a regression of
    // the entrypoint guard install path.
    await gateway.expectGuardChainActive(instance);

    progress.phase("wipe guard chain and gateway tree");
    // ── Disrupt ──────────────────────────────────────────────────────
    // Deterministic pod-recreate-equivalent state: /tmp is empty of the guard
    // chain, and the OpenClaw process tree is gone. This avoids coupling the
    // merge gate to a host-specific pod/container delete primitive while still
    // exercising the production sandbox-exec recovery route below.
    await sandbox.wipeGuardChain(instance.sandboxName);
    await sandbox.killGatewayTree(instance.sandboxName);

    progress.phase("recover gateway through connect probe");
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

    progress.phase("validate recovered guard and stable PID");
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
    const stableIdentity = await gateway.expectPidStable(instance, {
      durationSeconds: 30,
      pollIntervalSeconds: 5,
    });

    expect(stableIdentity.pid).toBeGreaterThan(0);

    progress.phase("restart sandbox container with persisted startup command");
    // A Docker restart must reuse the container and its credential-free managed
    // startup command. The command must restore the supervisor without a
    // container recreation transaction.
    const originalContainerId = await findSandboxContainer(host, "restart-container-before");
    const originalStartupCommand = await inspectStartupCommand(
      host,
      originalContainerId,
      "restart-command-before",
    );
    expect(originalStartupCommand).toMatch(/(?:^| )\/usr\/local\/bin\/nemoclaw-start$/);
    await host.cleanupForward(18789, {
      artifactName: "restart-stop-dashboard-forward",
      env: buildAvailabilityProbeEnv(),
    });
    const restart = await host.command("docker", ["restart", originalContainerId], {
      artifactName: "restart-docker-restart",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    expect(restart.exitCode, resultText(restart)).toBe(0);
    await waitForSandboxExecReady(host, instance.sandboxName, progress, "restart-openshell-ready");

    progress.phase("recover managed supervisor and inference");
    const credentialCanary = "nemoclaw-e2e-recovery-secret-restart";
    const trustedRecovery = await host.nemoclaw([instance.sandboxName, "recover"], {
      artifactName: "restart-trusted-recover",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "CUSTOM_PROVIDER_CREDENTIAL",
        CUSTOM_PROVIDER_CREDENTIAL: credentialCanary,
      },
      redactionValues: [credentialCanary],
      timeoutMs: 240_000,
    });
    const restartManagedState = await captureManagedGatewayState(
      host,
      originalContainerId,
      "restart",
    );
    expect(trustedRecovery.timedOut, "trusted recovery should complete before timeout").toBe(false);
    expect(trustedRecovery.exitCode, "trusted recovery should exit successfully").toBe(0);
    expectManagedGatewayState(restartManagedState);
    const restartStateLockPlan = await sandbox.exec(
      instance.sandboxName,
      ["python3", "-c", OPENCLAW_STATE_LOCK_PLAN_PROBE],
      { artifactName: "restart-installed-state-lock-plan", env: buildAvailabilityProbeEnv() },
    );
    expect(restartStateLockPlan.exitCode, resultText(restartStateLockPlan)).toBe(0);
    expect(restartStateLockPlan.stdout).toContain("OPENCLAW_STATE_LOCK_PLAN=installed");

    const recoveredContainerId = await findSandboxContainer(host, "restart-container-after");
    expect(recoveredContainerId).toBe(originalContainerId);
    const recoveredStartupCommand = await inspectStartupCommand(
      host,
      recoveredContainerId,
      "restart-command-after",
    );
    expect(recoveredStartupCommand).toMatch(/(?:^| )\/usr\/local\/bin\/nemoclaw-start$/);
    expect(recoveredStartupCommand).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(recoveredStartupCommand).not.toContain(credentialCanary);

    const topology = await sandbox.exec(
      instance.sandboxName,
      ["python3", "-c", SUPERVISOR_TOPOLOGY_SCRIPT],
      {
        artifactName: "restart-managed-supervisor-topology",
        env: buildAvailabilityProbeEnv(),
      },
    );
    expect(topology.exitCode, resultText(topology)).toBe(0);
    expect(topology.stdout).toMatch(/MANAGED_SUPERVISOR=[0-9]+:PPID1/);

    const forwardedHealth = await host.command(
      "curl",
      ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18789/health"],
      {
        artifactName: "restart-forwarded-health",
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
        `e2e-restart-${Date.now()}-${process.pid}`,
        "-m",
        "What is 6 multiplied by 7? Reply with only the integer, no extra words.",
      ],
      {
        artifactName: "restart-agent-inference",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 120_000,
      },
    );
    expect(inference.exitCode, resultText(inference)).toBe(0);
    expect(
      containsAnswer(parseOpenClawAgentText(inference.stdout), "42"),
      resultText(inference),
    ).toBe(true);

    progress.phase("recreate and restart sandbox container with legacy keepalive");
    // ── Assert #6635 legacy Docker restart recovery ────────────────
    // Existing sandboxes may still persist the historical keepalive. Recreate
    // that exact state from the identity-pinned modern container so recovery
    // proves the compatibility migration independently of fresh onboarding.
    await host.cleanupForward(18789, {
      artifactName: "legacy-restart-stop-dashboard-forward",
      env: buildAvailabilityProbeEnv(),
    });
    const createLegacyKeepalive = await host.command(
      "npx",
      ["--no-install", "tsx", LEGACY_KEEPALIVE_FIXTURE, instance.sandboxName, recoveredContainerId],
      {
        artifactName: "legacy-restart-create-keepalive",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 240_000,
      },
    );
    expect(createLegacyKeepalive.exitCode, resultText(createLegacyKeepalive)).toBe(0);
    const handoffReceipt = parseLegacyKeepaliveHandoffReceipt(createLegacyKeepalive.stdout);
    expect(handoffReceipt.newContainerId).toMatch(/^[0-9a-f]{64}$/iu);
    // Do not overlap the fixture's recreation with the restart below. The
    // fixture runs in its own process, so the host must observe the replacement
    // through OpenShell before starting the next container lifecycle transition.
    await waitForSandboxExecReady(
      host,
      instance.sandboxName,
      progress,
      "legacy-recreate-openshell-ready",
    );

    const legacyContainerId = await findSandboxContainer(host, "legacy-restart-container-before");
    expect(legacyContainerId).toBe(handoffReceipt.newContainerId);
    expect(legacyContainerId).not.toBe(recoveredContainerId);
    expect(
      await inspectStartupCommand(host, legacyContainerId, "legacy-restart-command-before"),
    ).toBe("sleep infinity");
    const legacyRestart = await host.command("docker", ["restart", legacyContainerId], {
      artifactName: "legacy-restart-docker-restart",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 120_000,
    });
    expect(legacyRestart.exitCode, resultText(legacyRestart)).toBe(0);
    await waitForSandboxExecReady(
      host,
      instance.sandboxName,
      progress,
      "legacy-restart-openshell-ready",
    );
    await gateway.waitForMissingManagedSupervisor(legacyContainerId, {
      onRetry: (attempt) => progress.event(`managed supervisor absence proof retry ${attempt}`),
    });

    progress.phase("recover legacy managed supervisor and inference");
    const legacyCredentialCanary = "nemoclaw-e2e-recovery-secret-6635";
    const legacyRecovery = await host.nemoclaw([instance.sandboxName, "recover"], {
      artifactName: "legacy-restart-trusted-recover",
      env: {
        ...buildAvailabilityProbeEnv(),
        NEMOCLAW_REBUILD_VERBOSE: "1",
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: "CUSTOM_PROVIDER_CREDENTIAL",
        CUSTOM_PROVIDER_CREDENTIAL: legacyCredentialCanary,
      },
      redactionValues: [legacyCredentialCanary],
      timeoutMs: 240_000,
    });
    const legacyRecoveredContainerId = await findSandboxContainer(
      host,
      "legacy-restart-container-after",
    );
    const legacyManagedState = await captureManagedGatewayState(
      host,
      legacyRecoveredContainerId,
      "legacy-restart",
    );
    expect(legacyRecovery.timedOut, "legacy recovery should complete before timeout").toBe(false);
    expect(legacyRecovery.exitCode, "legacy recovery should exit successfully").toBe(0);
    expectManagedGatewayState(legacyManagedState);
    const legacyStateLockPlan = await sandbox.exec(
      instance.sandboxName,
      ["python3", "-c", OPENCLAW_STATE_LOCK_PLAN_PROBE],
      {
        artifactName: "legacy-restart-installed-state-lock-plan",
        env: buildAvailabilityProbeEnv(),
      },
    );
    expect(legacyStateLockPlan.exitCode, resultText(legacyStateLockPlan)).toBe(0);
    expect(legacyStateLockPlan.stdout).toContain("OPENCLAW_STATE_LOCK_PLAN=installed");

    expect(legacyRecoveredContainerId).not.toBe(legacyContainerId);
    const legacyRecoveredStartupCommand = await inspectStartupCommand(
      host,
      legacyRecoveredContainerId,
      "legacy-restart-command-after",
    );
    expect(legacyRecoveredStartupCommand).toMatch(/(?:^| )(?:\/usr\/local\/bin\/)?nemoclaw-start$/);
    expect(legacyRecoveredStartupCommand).not.toContain("CUSTOM_PROVIDER_CREDENTIAL");
    expect(legacyRecoveredStartupCommand).not.toContain(legacyCredentialCanary);

    const legacyTopology = await sandbox.exec(
      instance.sandboxName,
      ["python3", "-c", SUPERVISOR_TOPOLOGY_SCRIPT],
      {
        artifactName: "legacy-restart-managed-supervisor-topology",
        env: buildAvailabilityProbeEnv(),
      },
    );
    expect(legacyTopology.exitCode, resultText(legacyTopology)).toBe(0);
    expect(legacyTopology.stdout).toMatch(/MANAGED_SUPERVISOR=[0-9]+:PPID1/);

    const legacyForwardedHealth = await host.command(
      "curl",
      ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18789/health"],
      {
        artifactName: "legacy-restart-forwarded-health",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(legacyForwardedHealth.exitCode, resultText(legacyForwardedHealth)).toBe(0);
    expect(legacyForwardedHealth.stdout.trim()).toMatch(/^(200|401)$/);

    const legacyInference = await host.nemoclaw(
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
    expect(legacyInference.exitCode, resultText(legacyInference)).toBe(0);
    expect(
      containsAnswer(parseOpenClawAgentText(legacyInference.stdout), "42"),
      resultText(legacyInference),
    ).toBe(true);
  },
);
