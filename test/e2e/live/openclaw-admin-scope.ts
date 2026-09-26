// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { adminApprovalConnectScript } from "../fixtures/admin-approval-connect.ts";
import { type HostCliClient, type SandboxClient, resultText } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  pendingAdminRequestId,
  preApprovalAdminProbeEvidence,
} from "../fixtures/issue-4462-admin-approval-evidence.ts";

const AGENT_TIMEOUT_MS = 3 * 60_000;
const OPENCLAW_ADMIN_APPROVAL_CAPTURE_LIMIT_BYTES = 64 * 1024;
const OPENCLAW_ADMIN_APPROVAL_MARKER = "ISSUE_5324_ADMIN_APPROVAL_OK";

export async function approveOpenClawAdminScope(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: readonly string[] = [],
): Promise<void> {
  const cronName = `managed-activation-admin-${Date.now()}`;
  const trigger = await sandbox.exec(
    sandboxName,
    [
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
      artifactName: "openclaw-cron-add-before-admin-approval",
      env,
      redactionValues: [...redactionValues],
      timeoutMs: AGENT_TIMEOUT_MS,
    },
  );
  const requestId = pendingAdminRequestId(trigger);
  const approval = requestId
    ? await host.command(
        "bash",
        ["-lc", adminApprovalConnectScript(host.commandPath, sandboxName, cronName, requestId)],
        {
          artifactName: "openclaw-explicit-admin-approval",
          captureLimitBytes: OPENCLAW_ADMIN_APPROVAL_CAPTURE_LIMIT_BYTES,
          env,
          redactionValues: [...redactionValues],
          timeoutMs: 4 * 60_000,
        },
      )
    : null;
  const approvalSucceeded =
    requestId !== null &&
    preApprovalAdminProbeEvidence(trigger).outcome === "approval-required" &&
    approval !== null &&
    approval.exitCode === 0 &&
    resultText(approval).includes(OPENCLAW_ADMIN_APPROVAL_MARKER);
  expect(
    approvalSucceeded,
    [
      "OpenClaw explicit admin approval did not authorize the cron consumer",
      resultText(trigger),
      approval ? resultText(approval) : "request ID unavailable",
    ].join("\n"),
  ).toBe(true);
}
