// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { loadAgent } from "../../../src/lib/agent/defs.ts";
import { getOccupiedPorts } from "../../../src/lib/onboard/dashboard-port.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  type HostedInferenceConfig,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";

const AGENT_NAME = process.env.NEMOCLAW_AGENT ?? "openclaw";
const AGENT = loadAgent(AGENT_NAME);
const QUALIFICATION = AGENT.quarantineQualification;
if (!QUALIFICATION) throw new Error(`Agent '${AGENT_NAME}' has no quarantine qualification`);
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-quarantine-${AGENT_NAME}`;
validateSandboxName(SANDBOX_NAME);
const IDEMPOTENCY_KEY = `quarantine-live-${AGENT_NAME}-request`;
const SECRET_CANARY = `quarantine-live-${AGENT_NAME}-secret-canary`;

function commandJson(result: ShellProbeResult, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} did not return one JSON document: ${resultText(result)}`);
  }
}

function commandEnvironment(hosted: HostedInferenceConfig): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...hosted.env,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: AGENT_NAME,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
  };
}

async function execInSandbox(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
}

async function expectDenied(
  host: HostCliClient,
  args: string[],
  artifactName: string,
  hosted: HostedInferenceConfig,
): Promise<void> {
  const result = await host.nemoclaw(args, {
    artifactName,
    env: commandEnvironment(hosted),
    redactionValues: [hosted.apiKey, SECRET_CANARY],
    timeoutMs: 90_000,
  });
  expect(result.timedOut, resultText(result)).toBe(false);
  expect(result.exitCode, resultText(result)).not.toBe(0);
  expect(resultText(result)).toContain("quarantined");
  expect(resultText(result)).not.toContain(SECRET_CANARY);
}

async function expectHostPortFree(
  host: HostCliClient,
  port: number,
  artifactName: string,
): Promise<void> {
  const result = await host.command(
    process.execPath,
    [
      "-e",
      'const net=require("node:net"); const server=net.createServer(); server.once("error", error => { console.error(error.code || error.message); process.exit(1); }); server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(error => process.exit(error ? 1 : 0)));',
      String(port),
    ],
    {
      artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, `host forward ${String(port)} is stopped`);
}

test(
  `all-agent quarantine qualifies ${AGENT_NAME}`,
  {
    timeout: 45 * 60_000,
    meta: {
      e2ePhases: [
        "onboard the qualified agent",
        "publish the durable fence and stop the exact runtime",
        "verify access and mutation denial from fresh CLI processes",
        "verify observational evidence commands and idempotent recovery",
        "release without starting and then explicitly restart",
      ],
    },
  },
  async ({ artifacts, cleanup, docker, host, progress, sandbox, secrets }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const env = commandEnvironment(hosted);
    expect(process.env.E2E_TARGET_ID ?? QUALIFICATION.liveE2eTarget).toBe(
      QUALIFICATION.liveE2eTarget,
    );

    await artifacts.target.declare({
      id: QUALIFICATION.liveE2eTarget,
      boundary:
        "manifest-qualified agent through durable registry fence, exact provider stop, independent observation, command denial, explicit release, and restart",
      agent: AGENT_NAME,
      contractVersion: QUALIFICATION.contractVersion,
    });
    await docker.requireDocker();
    cleanup.trackGateway(host, "nemoclaw", { env, timeoutMs: 5 * 60_000 });
    cleanup.trackSandbox(host, SANDBOX_NAME);
    await host.bestEffortCleanupSandbox(SANDBOX_NAME, {
      artifactName: `${AGENT_NAME}-quarantine-preclean`,
      env,
      timeoutMs: 5 * 60_000,
    });

    progress.phase("onboard the qualified agent");
    const onboard = await host.nemoclaw(
      ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
      {
        artifactName: `${AGENT_NAME}-quarantine-onboard`,
        env,
        redactionValues: [hosted.apiKey, SECRET_CANARY],
        timeoutMs: 20 * 60_000,
      },
    );
    assertExitZero(onboard, `onboard ${AGENT_NAME}`);
    const forwardsBeforeQuarantine = await sandbox.openshell(["forward", "list"], {
      artifactName: `${AGENT_NAME}-quarantine-forward-list-before`,
      env,
      timeoutMs: 30_000,
    });
    assertExitZero(forwardsBeforeQuarantine, "list access forwards before quarantine");
    const ownedForwardPorts = [...getOccupiedPorts(forwardsBeforeQuarantine.stdout)]
      .filter(([, owner]) => owner === SANDBOX_NAME)
      .map(([port]) => Number(port));
    if ((AGENT.forward_ports ?? []).length > 0) {
      expect(
        ownedForwardPorts.length,
        "qualified gateway agent has an owned access forward",
      ).toBeGreaterThan(0);
    }
    const marker = await execInSandbox(
      sandbox,
      "printf quarantine-preserved >/sandbox/quarantine-marker",
      `${AGENT_NAME}-quarantine-marker`,
    );
    assertExitZero(marker, "write pre-quarantine marker");

    progress.phase("publish the durable fence and stop the exact runtime");
    const quarantine = await host.nemoclaw(
      [
        SANDBOX_NAME,
        "quarantine",
        "--reason",
        `incident api_key=${SECRET_CANARY}`,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
        "--json",
      ],
      {
        artifactName: `${AGENT_NAME}-quarantine-apply`,
        env,
        redactionValues: [hosted.apiKey, SECRET_CANARY],
        timeoutMs: 5 * 60_000,
      },
    );
    assertExitZero(quarantine, "quarantine exact runtime");
    const payload = commandJson(quarantine, "quarantine");
    expect(payload.status).toBe("quarantined");
    const receipt = payload.receipt as {
      fence?: {
        attempts?: { operation?: string; outcome?: string }[];
        target?: { runtime?: { handle?: string } };
      };
      status?: string;
    };
    expect(receipt.status).toBe("quarantined");
    const attempts = receipt.fence?.attempts ?? [];
    expect(attempts[0]).toMatchObject({ operation: "fence-persistence", outcome: "succeeded" });
    for (const operation of [
      "messaging-stop",
      "dashboard-stop",
      "service-access-stop",
      "workload-stop",
      "execution-observation",
      "sandbox-access-observation",
    ]) {
      expect(attempts).toContainEqual(expect.objectContaining({ operation, outcome: "succeeded" }));
    }
    const receiptPath = String(payload.receiptPath);
    const receiptBytes = fs.readFileSync(receiptPath, "utf8");
    expect(receiptBytes).not.toContain(IDEMPOTENCY_KEY);
    expect(receiptBytes).not.toContain(SECRET_CANARY);
    expect(receiptBytes).not.toContain(hosted.apiKey);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    const runtimeHandle = receipt.fence?.target?.runtime?.handle;
    expect(runtimeHandle).toMatch(/^[a-f0-9]{64}$/u);
    const exactRuntime = await host.command(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", String(runtimeHandle)],
      {
        artifactName: `${AGENT_NAME}-quarantine-exact-runtime-stopped`,
        env,
        timeoutMs: 30_000,
      },
    );
    assertExitZero(exactRuntime, "inspect exact quarantined runtime");
    expect(exactRuntime.stdout.trim()).toBe("false");

    progress.phase("verify access and mutation denial from fresh CLI processes");
    const deniedExec = await execInSandbox(
      sandbox,
      "true",
      `${AGENT_NAME}-quarantine-openshell-access-denied`,
    );
    expect(deniedExec.exitCode, resultText(deniedExec)).not.toBe(0);
    for (const port of ownedForwardPorts) {
      await expectHostPortFree(
        host,
        port,
        `${AGENT_NAME}-quarantine-forward-${String(port)}-stopped`,
      );
    }
    const deniedCommands: [string[], string][] = [
      [[SANDBOX_NAME, "exec", "--", "true"], "exec"],
      [[SANDBOX_NAME, "start"], "start"],
      [[SANDBOX_NAME, "recover"], "recover"],
      [[SANDBOX_NAME, "rebuild", "--yes"], "rebuild"],
      [[SANDBOX_NAME, "snapshot", "restore"], "restore"],
      [[SANDBOX_NAME, "shields", "down", "--reason", "quarantine test"], "shields"],
      [["upgrade-sandboxes", "--auto", "--yes"], "upgrade"],
      [
        ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
        "onboard-reuse",
      ],
    ];
    for (const [args, label] of deniedCommands) {
      await expectDenied(host, args, `${AGENT_NAME}-quarantine-${label}-denied`, hosted);
    }

    progress.phase("verify observational evidence commands and idempotent recovery");
    const status = await host.nemoclaw([SANDBOX_NAME, "status"], {
      artifactName: `${AGENT_NAME}-quarantine-status`,
      env,
      timeoutMs: 90_000,
    });
    assertExitZero(status, "quarantine status evidence");
    expect(resultText(status)).toContain(String(payload.fenceId));
    const doctor = await host.nemoclaw([SANDBOX_NAME, "doctor"], {
      artifactName: `${AGENT_NAME}-quarantine-doctor`,
      env,
      timeoutMs: 90_000,
    });
    expect(doctor.timedOut, resultText(doctor)).toBe(false);
    const stillDenied = await execInSandbox(
      sandbox,
      "true",
      `${AGENT_NAME}-quarantine-observation-did-not-recover`,
    );
    expect(stillDenied.exitCode, resultText(stillDenied)).not.toBe(0);
    const retry = await host.nemoclaw(
      [
        SANDBOX_NAME,
        "quarantine",
        "--reason",
        `incident api_key=${SECRET_CANARY}`,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
        "--json",
      ],
      {
        artifactName: `${AGENT_NAME}-quarantine-idempotent-retry`,
        env,
        redactionValues: [hosted.apiKey, SECRET_CANARY],
        timeoutMs: 90_000,
      },
    );
    assertExitZero(retry, "quarantine retry from a fresh process");
    expect(commandJson(retry, "quarantine retry").fenceId).toBe(payload.fenceId);

    progress.phase("release without starting and then explicitly restart");
    const release = await host.nemoclaw(
      [SANDBOX_NAME, "quarantine", "release", "--fence-id", String(payload.fenceId)],
      {
        artifactName: `${AGENT_NAME}-quarantine-release`,
        env,
        timeoutMs: 90_000,
      },
    );
    assertExitZero(release, "release exact quarantine fence");
    const releaseDidNotStart = await execInSandbox(
      sandbox,
      "true",
      `${AGENT_NAME}-quarantine-release-does-not-start`,
    );
    expect(releaseDidNotStart.exitCode, resultText(releaseDidNotStart)).not.toBe(0);
    const start = await host.nemoclaw([SANDBOX_NAME, "start"], {
      artifactName: `${AGENT_NAME}-quarantine-explicit-start`,
      env,
      timeoutMs: 5 * 60_000,
    });
    assertExitZero(start, "explicit start after release");
    const preserved = await execInSandbox(
      sandbox,
      'test "$(cat /sandbox/quarantine-marker)" = quarantine-preserved',
      `${AGENT_NAME}-quarantine-marker-preserved`,
    );
    assertExitZero(preserved, "workspace marker after explicit start");

    await artifacts.target.complete({
      id: QUALIFICATION.liveE2eTarget,
      status: "passed",
      agent: AGENT_NAME,
      exactRuntimeStopped: true,
      commandDenialsValidated: deniedCommands.map(([, label]) => label),
      explicitReleaseAndRestartValidated: true,
      secretCanaryExcluded: true,
    });
  },
);
