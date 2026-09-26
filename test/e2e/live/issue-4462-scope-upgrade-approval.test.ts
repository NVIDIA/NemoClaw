// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";
import { execTimeout, testTimeout } from "../../helpers/timeouts.ts";
import {
  ALLOWLISTED_REQUEST_TRIGGER_SH,
  allowlistedApprovalConnectScript,
} from "../fixtures/allowlisted-approval-connect.ts";
import { adminApprovalConnectScript } from "../fixtures/admin-approval-connect.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { trackIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import {
  pendingAdminRequestId,
  preApprovalAdminProbeEvidence,
} from "../fixtures/issue-4462-admin-approval-evidence.ts";
import { ISSUE_4462_SCOPE_UPGRADE_PHASES } from "./issue-4462-admin-approval-helper.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-issue-4462";
const LIVE_TIMEOUT_MS = testTimeout(70 * 60_000);
const INSTALL_TIMEOUT_MS = execTimeout(30 * 60_000);
const AUTO_PAIR_DEADLINE_SECS = String(INSTALL_TIMEOUT_MS / 1_000);
const GATEWAY_OBSERVATION_TIMEOUT_MS = 30_000;
const GATEWAY_OBSERVATION_TIMEOUT_SECS = String(GATEWAY_OBSERVATION_TIMEOUT_MS / 1_000);
const GATEWAY_OBSERVER_LOCAL_PATH = path.join(
  import.meta.dirname,
  "..",
  "lib",
  "issue-4462-fresh-agent-gateway-snapshot.py",
);
// OpenShell treats the upload destination as a directory. Upload to /tmp and
// execute the uploaded file by its basename.
const GATEWAY_OBSERVER_REMOTE_DIR = "/tmp";
const GATEWAY_OBSERVER_REMOTE_PATH = `${GATEWAY_OBSERVER_REMOTE_DIR}/issue-4462-fresh-agent-gateway-snapshot.py`;
const PENDING_ALLOWLISTED_REQUEST_LOCAL_PATH = path.join(
  import.meta.dirname,
  "..",
  "lib",
  "issue-4462-pending-allowlisted-request.py",
);

validateSandboxName(SANDBOX_NAME);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    // Preserve the default one-second re-entry cadence through operator.write
    // settlement. Delay slow-mode polling until after operator.admin approval.
    NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: AUTO_PAIR_DEADLINE_SECS,
    NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: AUTO_PAIR_DEADLINE_SECS,
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

interface FreshAgentGatewaySnapshot {
  activeOperatorTokenCount: number;
  activeOperatorTokenScopes: string[];
  approvedScopes: string[];
  deviceScopes: string[];
  matchingPairedCount: number;
  pairedCliCount: number;
  pendingCount: number;
  sameDevicePendingCount: number;
}

interface CapturedCommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function pendingAllowlistedRequestId(result: CapturedCommandResult): string | undefined {
  const matches = [
    ...`${result.stdout}\n${result.stderr}`.matchAll(
      /^ISSUE_4462_ALLOWLISTED_REQUEST_ID=([0-9a-f-]{36})$/gimu,
    ),
  ].map((match) => match[1]?.toLowerCase());
  const requestIds = [...new Set(matches.filter((value): value is string => !!value))];
  return result.exitCode !== 0 && requestIds.length === 1 ? requestIds[0] : undefined;
}

async function cleanup(host: HostCliClient, sandbox: SandboxClient): Promise<void> {
  await host
    .command(
      process.execPath,
      [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes", "--cleanup-gateway"],
      {
        artifactName: "cleanup-nemoclaw-destroy",
        env: env(),
        timeoutMs: 120_000,
      },
    )
    .catch(() => undefined);
  await sandbox
    .openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  await sandbox
    .openshell(["gateway", "remove", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
}
test(
  "settles allowlisted requests through connect and requires explicit operator.admin approval (#4462)",
  {
    timeout: LIVE_TIMEOUT_MS,
    meta: { e2ePhases: ISSUE_4462_SCOPE_UPGRADE_PHASES },
  },
  async ({
    artifacts,
    cleanup: cleanupRegistry,
    host,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
  }) => {
    const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    await artifacts.target.declare({
      id: "issue-4462-scope-upgrade-approval",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "install.sh creates a real OpenClaw sandbox",
        "fresh onboarding settles one CLI identity with operator.write and without a pending request or operator.admin",
        "a post-onboarding same-device CLI request remains pending after exec and connect settles it through the real gateway before retry",
        "the issue 5324 nemoclaw <name> exec transport reaches the local OpenClaw CLI pairing path",
        "the prepared connect shell keeps the injected gateway URL private while retaining port and token",
        "operator.admin remains pending until explicit device approval",
        "the retried cron add and cron run prove that the CLI identity can use operator.admin after approval",
      ],
    });

    await runtimeProvider.requireAvailable({
      artifactName: "phase-0-runtime-info",
      scenarioLabel: "scope-upgrade approval",
    });

    cleanupRegistry.trackGateway(host, "nemoclaw", {
      artifactName: "cleanup-openshell-gateway-destroy",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });
    cleanupRegistry.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
      sandbox.cleanupSandbox(SANDBOX_NAME, {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      }),
    );
    cleanupRegistry.trackSandbox(host, SANDBOX_NAME, {
      artifactName: "cleanup-nemoclaw-destroy",
      env: env(),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    });
    trackIssue4462FailureDiagnostics(cleanupRegistry, sandbox, SANDBOX_NAME, env(), [apiKey]);
    await cleanup(host, sandbox);
    progress.phase("install the OpenClaw sandbox");
    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "phase-1-install-sh",
        cwd: REPO_ROOT,
        env: env({ NVIDIA_INFERENCE_API_KEY: apiKey }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    expect(
      install.exitCode,
      "OpenClaw sandbox installation failed; inspect the phase artifact",
    ).toBe(0);

    const upload = await sandbox.upload(
      SANDBOX_NAME,
      GATEWAY_OBSERVER_LOCAL_PATH,
      GATEWAY_OBSERVER_REMOTE_DIR,
      {
        artifactName: "phase-2-upload-gateway-observer",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: GATEWAY_OBSERVATION_TIMEOUT_MS,
      },
    );
    const selectorUpload = await sandbox.upload(
      SANDBOX_NAME,
      PENDING_ALLOWLISTED_REQUEST_LOCAL_PATH,
      GATEWAY_OBSERVER_REMOTE_DIR,
      {
        artifactName: "phase-2-upload-pending-allowlisted-selector",
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: GATEWAY_OBSERVATION_TIMEOUT_MS,
      },
    );
    expect(
      selectorUpload.exitCode === 0 && upload.exitCode === 0,
      `Pending allowlisted selector upload must exit 0 (selector=${String(selectorUpload.exitCode)}, gateway-observer=${String(upload.exitCode)}); inspect the phase-2 upload artifacts`,
    ).toBe(true);

    const captureGatewayObservation = async <T>(phase: string): Promise<T> => {
      const result = await sandbox.exec(
        SANDBOX_NAME,
        ["python3", GATEWAY_OBSERVER_REMOTE_PATH, GATEWAY_OBSERVATION_TIMEOUT_SECS],
        {
          artifactName: phase,
          captureLimitBytes: 64 * 1024,
          env: env(),
          redactionValues: [apiKey],
          timeoutMs: GATEWAY_OBSERVATION_TIMEOUT_MS,
        },
      );
      expect(
        result.exitCode,
        `Gateway observation failed during ${phase}; inspect the phase artifact`,
      ).toBe(0);
      const observation = JSON.parse(result.stdout.trim()) as T;
      await artifacts.writeJson(`${phase}.json`, observation);
      return observation;
    };
    progress.phase("prove onboarding settled operator.write");
    const freshSnapshot =
      await captureGatewayObservation<FreshAgentGatewaySnapshot>("phase-2-fresh-state");
    expect(freshSnapshot).toMatchObject({
      activeOperatorTokenCount: 1,
      approvedScopes: ["operator.pairing", "operator.write"],
      deviceScopes: ["operator.pairing", "operator.write"],
      matchingPairedCount: 1,
      pairedCliCount: 1,
      pendingCount: 0,
      sameDevicePendingCount: 0,
    });
    expect(freshSnapshot.activeOperatorTokenScopes).toEqual([
      "operator.pairing",
      "operator.read",
      "operator.write",
    ]);

    progress.phase("settle a post-onboarding allowlisted request through connect");
    const allowlistedTrigger = await sandbox.exec(
      SANDBOX_NAME,
      ["bash", "-lc", ALLOWLISTED_REQUEST_TRIGGER_SH],
      {
        artifactName: "phase-3-trigger-allowlisted-request",
        captureLimitBytes: 64 * 1024,
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    const allowlistedRequestId = pendingAllowlistedRequestId(allowlistedTrigger) ?? "";
    const allowlistedConnect = await host.command(
      "bash",
      [
        "-lc",
        allowlistedApprovalConnectScript(host.commandPath, SANDBOX_NAME, allowlistedRequestId),
      ],
      {
        artifactName: "phase-4-connect-allowlisted-approval",
        captureLimitBytes: 64 * 1024,
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 4 * 60_000,
      },
    );
    const allowlistedConnectText = resultText(allowlistedConnect);
    const allowlistedConnectSucceeded =
      allowlistedConnect.exitCode === 0 &&
      allowlistedConnectText.includes("ISSUE_4462_ALLOWLISTED_RETRY_OK");
    expect(
      allowlistedConnectSucceeded,
      `Connect allowlisted approval proof failed with exit ${String(allowlistedConnect.exitCode)}`,
    ).toBe(true);

    progress.phase("trigger and approve an operator.admin request through connect");
    const cronName = `issue-5324-admin-${Date.now()}-${process.pid}`;
    const cronTrigger = await host.command(
      process.execPath,
      [
        CLI_ENTRYPOINT,
        SANDBOX_NAME,
        "exec",
        "--timeout",
        "60",
        "--",
        "openclaw",
        "cron",
        "add",
        "--name",
        cronName,
        "--every",
        "2h",
        "--agent",
        "main",
        "--session",
        "isolated",
        "--message",
        "hello",
      ],
      {
        captureLimitBytes: 64 * 1024,
        env: env(),
        persistArtifacts: false,
        redactionValues: [apiKey],
        timeoutMs: 90_000,
      },
    );
    const cronTriggerEvidence = preApprovalAdminProbeEvidence(cronTrigger);
    await artifacts.writeJson("phase-5-trigger-admin-cron.json", cronTriggerEvidence);
    const cronTriggerRequestId = pendingAdminRequestId(cronTrigger);
    expect(
      cronTriggerRequestId,
      "The operator.admin probe did not report one unambiguous pending request ID",
    ).not.toBeNull();

    const adminConnect = await host.command(
      "bash",
      [
        "-lc",
        adminApprovalConnectScript(
          host.commandPath,
          SANDBOX_NAME,
          cronName,
          cronTriggerRequestId as string,
        ),
      ],
      {
        artifactName: "phase-6-connect-admin-approval",
        captureLimitBytes: 64 * 1024,
        env: env(),
        redactionValues: [apiKey],
        timeoutMs: 4 * 60_000,
      },
    );
    const adminConnectSucceeded =
      adminConnect.exitCode === 0 &&
      resultText(adminConnect).includes("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(adminConnectSucceeded, "Explicit admin approval did not reach the settled state").toBe(
      true,
    );
    progress.phase("record the approval contract");
    await artifacts.target.complete({
      id: "issue-4462-scope-upgrade-approval",
      status: "passed",
    });
  },
);
