// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { adminApprovalConnectScript } from "../fixtures/admin-approval-connect.ts";
import { type HostCliClient, type SandboxClient, resultText } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { buildCliOpenShellSandboxExecArgs } from "../../../src/lib/adapters/openshell/sandbox-command-cli.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import {
  pendingAdminRequestId,
  preApprovalAdminProbeEvidence,
} from "../fixtures/issue-4462-admin-approval-evidence.ts";

const AGENT_TIMEOUT_MS = 3 * 60_000;
const OPENCLAW_ADMIN_APPROVAL_CAPTURE_LIMIT_BYTES = 64 * 1024;
const OPENCLAW_ADMIN_APPROVAL_MARKER = "ISSUE_5324_ADMIN_APPROVAL_OK";
const EXACT_PENDING_REQUEST_FILTER_PY =
  'import json,sys; data=json.load(sys.stdin); pending=data.get("pending"); pending=[] if pending is None else pending; want=str(sys.argv[1] or "").strip(); data["pending"]=[request for request in pending if str(request.get("requestId") or "").strip() == want]; json.dump(data,sys.stdout,separators=(",",":"))';

export function exactRequestAdminApprovalConnectScript(
  cliPath: string,
  sandboxName: string,
  cronName: string,
  expectedRequestId: string,
  verifyCronConsumer = true,
  connect: { readonly gatewayName: string; readonly openshellPath: string },
): string {
  const openshellConnect = [
    connect.openshellPath,
    ...buildCliOpenShellSandboxExecArgs({
      command: ["/bin/bash", "-i"],
      sandboxName,
      target: { kind: "named", gatewayName: connect.gatewayName },
      tty: true,
    }),
  ];
  const connectPrelude = [
    `export NEMOCLAW_ADMIN_EXPECTED_REQUEST_ID=${shellQuote(expectedRequestId)};`,
    'nemoclaw_original_openclaw_definition="$(declare -f openclaw)";',
    "case $? in 0) ;; *) exit 33 ;; esac;",
    'eval "nemoclaw_original_openclaw${nemoclaw_original_openclaw_definition#openclaw}";',
    "openclaw() {",
    '  case "$#:${1-}:${2-}:${3-}" in',
    "    3:devices:list:--json)",
    "      local -a command_status;",
    `      nemoclaw_original_openclaw "$@" | python3 -c ${shellQuote(EXACT_PENDING_REQUEST_FILTER_PY)} "$NEMOCLAW_ADMIN_EXPECTED_REQUEST_ID";`,
    '      command_status=("${PIPESTATUS[@]}");',
    '      case "${command_status[0]}" in 0) return "${command_status[1]}" ;; *) return "${command_status[0]}" ;; esac;',
    "      ;;",
    "  esac;",
    '  nemoclaw_original_openclaw "$@";',
    "};",
    "export -f nemoclaw_original_openclaw openclaw;",
  ].join(" ");
  return adminApprovalConnectScript(
    cliPath,
    sandboxName,
    cronName,
    expectedRequestId,
    verifyCronConsumer,
    { connectCommand: openshellConnect, preparedShellPrelude: connectPrelude },
  );
}

export async function approveOpenClawAdminScope(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactionValues: readonly string[] = [],
  verifyCronConsumer = true,
): Promise<void> {
  const cronName = `openclaw-admin-approval-${Date.now()}`;
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
        [
          // Host login/logout hooks must not change the approval exit status.
          "-c",
          exactRequestAdminApprovalConnectScript(
            host.commandPath,
            sandboxName,
            cronName,
            requestId,
            verifyCronConsumer,
            {
              gatewayName: env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
              openshellPath: host.openshellCommandPath,
            },
          ),
        ],
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
      "OpenClaw explicit admin approval did not complete",
      resultText(trigger),
      approval ? resultText(approval) : "request ID unavailable",
    ].join("\n"),
  ).toBe(true);
}
