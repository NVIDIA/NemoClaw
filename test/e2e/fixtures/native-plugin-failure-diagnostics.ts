// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../../../src/lib/core/json-types.ts";
import {
  openClawFinalAgentResponse,
  openClawAgentResponseRecord,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";
import { type SandboxClient, trustedSandboxShellScript } from "./clients/sandbox.ts";

const DIAGNOSTIC_BUDGET_MS = 10_000;
const AUDIT_OUTCOMES = [
  "started",
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "timed_out",
  "unknown",
];
const FIXTURE_TOOL = /^nemoclaw_e2e_check_v[12]$/u;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function boundedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100
    ? Number(value)
    : null;
}

/** Read only the gateway envelope; a model reply cannot authorize an audit lookup. */
function failedRun(raw: string) {
  if (raw.length > 128 * 1024) return null;
  const documents = parseOpenClawJsonDocuments(raw);
  if (documents.filter((doc) => openClawAgentResponseRecord(doc) !== null).length !== 1)
    return null;
  const final = openClawFinalAgentResponse(documents);
  return final && typeof final.document.runId === "string" && RUN_ID.test(final.document.runId)
    ? final
    : null;
}

function turnEvidence(final: ReturnType<typeof failedRun>, toolName: string | undefined) {
  const agent = isObjectRecord(final?.meta.agentMeta) ? final.meta.agentMeta : {};
  const bridge = isObjectRecord(agent.bridgeCalls) ? agent.bridgeCalls : {};
  const prompt = isObjectRecord(final?.meta.systemPromptReport)
    ? final.meta.systemPromptReport
    : {};
  const tools = isObjectRecord(prompt.tools) ? prompt.tools : {};
  const phase = final?.meta.timeoutPhase;
  return {
    identifiedRun: final !== null,
    timeoutPhase:
      typeof phase === "string" && ["provider", "queue", "tool"].includes(phase)
        ? phase
        : "unknown",
    targetAdvertised:
      toolName && Array.isArray(tools.entries) && tools.entries.length <= 200
        ? tools.entries.some((entry) => isObjectRecord(entry) && entry.name === toolName)
        : null,
    bridgeCalls: {
      search: boundedCount(bridge.search),
      describe: boundedCount(bridge.describe),
      call: boundedCount(bridge.call),
    },
  };
}

/** Keep closed-vocabulary counts, never audit identities, arguments, or diagnostic text. */
function auditEvidence(raw: string, runId: string, toolName: string) {
  const page: unknown = JSON.parse(raw);
  if (
    !isObjectRecord(page) ||
    !Array.isArray(page.events) ||
    page.events.length > 100 ||
    page.nextCursor !== undefined ||
    !page.events.every(isObjectRecord)
  )
    return { status: "invalid" };
  const counts = Object.fromEntries(AUDIT_OUTCOMES.map((status) => [status, 0]));
  for (const event of page.events) {
    if (event.runId !== runId || event.toolName !== toolName) continue;
    if (
      event.kind !== "tool_action" ||
      !["tool.action.started", "tool.action.finished"].includes(String(event.action)) ||
      !AUDIT_OUTCOMES.includes(String(event.status))
    )
      return { status: "invalid" };
    counts[String(event.status)]! += 1;
  }
  return { status: "available", counts };
}

/** Record bounded failure evidence without replaying a failed agent turn. */
export async function captureNativePluginFailureReadiness(
  sandbox: Pick<SandboxClient, "exec" | "execShell">,
  result: { exitCode: number | null; stdout?: string },
  sandboxName: string,
  artifactName: string,
  env: NodeJS.ProcessEnv,
  expectedTool?: string,
): Promise<void> {
  if (result.exitCode === 0) return;
  const deadline = performance.now() + DIAGNOSTIC_BUDGET_MS;
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const toolName = expectedTool && FIXTURE_TOOL.test(expectedTool) ? expectedTool : undefined;
  const final = failedRun(result.stdout ?? "");
  let audit: ReturnType<typeof auditEvidence> = { status: "unavailable" };
  const auditBudget = Math.min(3_000, remaining());
  if (final && toolName && auditBudget > 0) {
    try {
      const page = await sandbox.exec(
        sandboxName,
        [
          "openclaw",
          "audit",
          "--run",
          String(final.document.runId),
          "--kind",
          "tool_action",
          "--limit",
          "100",
          "--json",
        ],
        {
          artifactName: `${artifactName}-failure-audit`,
          env,
          captureLimitBytes: 32 * 1024,
          persistArtifacts: false,
          timeoutMs: auditBudget,
        },
      );
      if (page.exitCode === 0 && !page.timedOut && !page.signal)
        audit = auditEvidence(page.stdout, String(final.document.runId), toolName);
    } catch {
      // Diagnostics cannot replace the failed turn's status or trigger a replay.
    }
  }
  let readiness: { healthz: number | null; readyz: number | null } = {
    healthz: null,
    readyz: null,
  };
  if (remaining() > 0) {
    try {
      const probe = await sandbox.execShell(
        sandboxName,
        trustedSandboxShellScript(
          `. /tmp/nemoclaw-proxy-env.sh && for endpoint in healthz readyz; do printf '%s=' "$endpoint"; curl --noproxy '*' --max-time 3 --silent --output /dev/null --write-out '%{http_code}\\n' "http://127.0.0.1:\${OPENCLAW_GATEWAY_PORT:-18789}/$endpoint" || true; done`,
        ),
        {
          artifactName: `${artifactName}-readiness-after-failure`,
          env,
          captureLimitBytes: 1024,
          timeoutMs: remaining(),
        },
      );
      readiness = Object.fromEntries(
        ["healthz", "readyz"].map((name) => [
          name,
          Number(probe.stdout?.match(new RegExp(`^${name}=([0-9]{3})$`, "mu"))?.[1]) || null,
        ]),
      ) as typeof readiness;
    } catch {
      // Readiness is best effort within the same ten-second diagnostic reserve.
    }
  }
  // Launchable retains this bounded projection in full-e2e.log; guest artifact files are ephemeral.
  console.error(
    "NEMOCLAW_NATIVE_PLUGIN_FAILURE " +
      JSON.stringify({
        ...turnEvidence(final, toolName),
        audit,
        readiness,
      }),
  );
}
