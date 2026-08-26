// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import {
  assessPersonalStockToolEvidence,
  buildOpenClawToolEvidenceReducerScript,
  classifyOpenClawAgentAssertion,
  nvdaPersonalStockReplyMatchesEvidence,
  parseNvdaPersonalStockReply,
  parseOpenClawAgentText,
  projectNvdaPersonalStockReplyEvidence,
  projectPersonalStockToolEvidenceArtifact,
  runOpenClawAgentAssertionRetry,
  text,
  type NvdaPersonalStockReply,
  type OpenClawToolTarget,
  type OpenClawToolEvidence,
  type PersonalStockToolEvidenceArtifact,
  validateOpenClawAgentAttemptEvidence,
} from "./common-egress-agent-helpers.ts";

const AGENT_TURN_TIMEOUT_MS = 3 * 60_000;
const OPENCLAW_AGENT_ATTEMPTS = 3;

export interface OpenClawAgentAssertionEvidence {
  reply: string;
  toolEvidence?: OpenClawToolEvidence;
}

export interface OpenClawAgentAssertionOptions {
  apiKey: string;
  expected: string;
  label: string;
  prompt: string;
  persistCommandArtifacts?: boolean;
  redactOutputInFailure?: boolean;
  replyValidator?: (reply: string, evidence?: OpenClawToolEvidence) => boolean;
  sandboxName: string;
  toolEvidenceValidator?: (evidence: OpenClawToolEvidence) => boolean;
}

export interface PersonalStockAssertionResult {
  assessment: PersonalStockToolEvidenceArtifact;
  quote: {
    as_of: string;
    price: number;
    source: OpenClawToolTarget;
    status: "NVDA_PERSONAL_AGENT_OK";
    symbol: "NVDA";
  };
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

export async function runOpenClawAgentAssertion(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  args: OpenClawAgentAssertionOptions,
): Promise<OpenClawAgentAssertionEvidence> {
  const sshConfig = await sandbox.openshell(["sandbox", "ssh-config", args.sandboxName], {
    artifactName: `ssh-config-${args.label}`,
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(sshConfig.exitCode, text(sshConfig)).toBe(0);
  const sshConfigPath = await artifacts.writeText(
    `ssh/${args.label}-${args.sandboxName}.config`,
    sshConfig.stdout,
  );

  let lastFailure = "";
  let successfulEvidence: OpenClawAgentAssertionEvidence | null = null;
  const execution = await runOpenClawAgentAssertionRetry({
    attempts: OPENCLAW_AGENT_ATTEMPTS,
    delayMs: (attempt) => attempt * 15_000,
    onEvidence: async (evidence) => {
      await artifacts.writeJson(`actions/${args.label}-agent-retry-evidence.json`, evidence);
    },
    run: async (attempt) => {
      const sessionId = `e2e-common-egress-${Date.now()}-${process.pid}-${attempt}`;
      const sessionRoot = "/sandbox/.openclaw/agents/main/sessions";
      const remoteCommand = [
        `rm -f ${shellQuote(`${sessionRoot}/${sessionId}.jsonl`)} ${shellQuote(
          `${sessionRoot}/${sessionId}.jsonl.lock`,
        )} ${shellQuote(`${sessionRoot}/${sessionId}.trajectory.jsonl`)} 2>/dev/null || true`,
        `openclaw agent --agent main --json --thinking off --session-id ${shellQuote(
          sessionId,
        )} -m ${shellQuote(args.prompt)}`,
      ].join("; ");
      const agent = await host.command(
        "ssh",
        [
          "-F",
          sshConfigPath,
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=10",
          "-o",
          "LogLevel=ERROR",
          `openshell-${args.sandboxName}.default`,
          remoteCommand,
        ],
        {
          artifactName: `${args.label}-openclaw-agent-attempt-${attempt}`,
          env: commandEnv(),
          persistArtifacts: args.persistCommandArtifacts !== false,
          redactionValues: [args.apiKey],
          timeoutMs: AGENT_TURN_TIMEOUT_MS,
        },
      );
      const combined = text(agent);
      const reply = parseOpenClawAgentText(agent.stdout);
      const stockReplyEvidence = projectNvdaPersonalStockReplyEvidence(reply);
      if (stockReplyEvidence) {
        await artifacts.writeJson(`actions/${args.label}-attempt-${attempt}-reply.json`, {
          schemaVersion: 1,
          quote: stockReplyEvidence,
        });
      }
      lastFailure = args.redactOutputInFailure
        ? `agent output omitted; exit=${agent.exitCode}`
        : `reply='${reply.slice(0, 240)}' exit=${agent.exitCode} stdout='${agent.stdout.slice(
            0,
            240,
          )}' stderr='${agent.stderr.slice(0, 240)}'`;
      const classification = classifyOpenClawAgentAssertion({
        exitCode: agent.exitCode,
        expected: args.expected,
        reply,
        response: combined,
      });
      const validation = await validateOpenClawAgentAttemptEvidence({
        classification,
        label: args.label,
        recordToolEvidence: async (toolEvidence) => {
          await artifacts.writeJson(
            `actions/${args.label}-attempt-${attempt}-reduced.json`,
            projectPersonalStockToolEvidenceArtifact(toolEvidence),
          );
        },
        reduceToolEvidence: async (expectedStock) =>
          sandbox.exec(
            args.sandboxName,
            [
              "node",
              "-e",
              buildOpenClawToolEvidenceReducerScript(expectedStock),
              `${sessionRoot}/${sessionId}.jsonl`,
              `${sessionRoot}/${sessionId}.trajectory.jsonl`,
            ],
            {
              env: commandEnv(),
              persistArtifacts: false,
              timeoutMs: 30_000,
            },
          ),
        reply,
        replyValidator: args.replyValidator,
        toolEvidenceValidator: args.toolEvidenceValidator,
      });
      lastFailure = validation.failure ?? lastFailure;
      successfulEvidence = validation.evidence ?? successfulEvidence;
      return validation.attempt;
    },
    recover: async (_attempt, attemptNumber) => {
      const recover = await host.command("node", [CLI_ENTRYPOINT, args.sandboxName, "recover"], {
        artifactName: `${args.label}-recover-after-attempt-${attemptNumber}`,
        env: commandEnv(),
        timeoutMs: 120_000,
      });
      if (recover.exitCode !== 0) {
        lastFailure = `recovery exit=${recover.exitCode}`;
        return false;
      }
      return true;
    },
  });
  if (execution.outcome === "passed" && successfulEvidence) return successfulEvidence;
  throw new Error(`${args.label}: expected ${args.expected}, got ${lastFailure}`);
}

export const PERSONAL_STOCK_PROMPT = `Find the latest available NVIDIA (NVDA) stock price.
Choose a small, machine-readable public HTTPS source whose response contains one NVDA price and its market or update timestamp.
Use web_fetch as the only target tool.
If progressive tool disclosure is active, you may use tool_search, tool_describe, and tool_call only to discover and invoke web_fetch.
Do not invoke any other target tool. Do not use web_search, Brave Search, or Tavily Search.
Set web_fetch maxChars to no more than 8000.
If a web_fetch result omits the quote timestamp, do not use its price or infer a timestamp.
Fetch a different machine-readable source instead.
Reply only after one web_fetch result contains NVDA, a numeric price, and its market or update timestamp.
Keep each web_fetch result isolated. Never combine a price from one result with a timestamp from another result.
Select exactly one complete result and ignore every unselected result when constructing the reply.
Use the price and timestamp from that result. Set source_url to the exact URL for its paired web_fetch call.
If no result contains all three values, do not return success.
Reply with one JSON object and no Markdown.
Return these fields:
- status: NVDA_PERSONAL_AGENT_OK
- symbol: NVDA
- price: the quote price as a JSON number
- source_url: the exact URL for the paired web_fetch call
- source_timestamp: the exact timestamp token copied without editing from the selected result, as a JSON string
- as_of: the ISO 8601 representation of source_timestamp
Copy source_timestamp character for character from the selected result before deriving as_of. Treat a timestamp as returned only when that exact token occurs in the selected result.
Do not reconstruct source_timestamp from as_of, a nearby field, market hours, or date arithmetic.
Copy an extended ISO 8601 source date or timestamp exactly. Convert a compact YYYYMMDD source date to YYYY-MM-DD.
If a source value has a calendar date but no clock time, return YYYY-MM-DD. Never add a clock time or timezone to a date-only value.
For a Unix-epoch field such as regularMarketTime, interpret the exact integer as seconds or milliseconds since 1970-01-01T00:00:00Z and convert that instant to UTC ISO 8601 without applying exchange hours, timezone labels, or daylight-saving rules.
Before replying, check in this order that source_timestamp appears exactly in the selected result, the same result contains the selected NVDA price, and as_of represents source_timestamp exactly. For a Unix epoch, reverse-convert as_of to the same unit and require exact integer equality.
If any check fails, discard that result and fetch a different machine-readable source instead of returning success.
Never use the current clock, fetch time, or an unrelated date for as_of.`;

export async function runPersonalStockAgentAssertion(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  args: { apiKey: string; label: string; sandboxName: string },
): Promise<PersonalStockAssertionResult> {
  expect(PERSONAL_STOCK_PROMPT).not.toMatch(/\bhttps?:\/\//iu);
  const stock = await runOpenClawAgentAssertion(host, sandbox, artifacts, {
    apiKey: args.apiKey,
    expected: "NVDA_PERSONAL_AGENT_OK",
    label: args.label,
    persistCommandArtifacts: false,
    prompt: PERSONAL_STOCK_PROMPT,
    redactOutputInFailure: true,
    replyValidator: (reply, evidence) =>
      evidence !== undefined && nvdaPersonalStockReplyMatchesEvidence(reply, evidence),
    sandboxName: args.sandboxName,
    toolEvidenceValidator: (evidence) => assessPersonalStockToolEvidence(evidence).matches,
  });
  expect(stock.toolEvidence).toBeDefined();
  const assessmentArtifact = projectPersonalStockToolEvidenceArtifact(stock.toolEvidence!);
  const quote = parseNvdaPersonalStockReply(stock.reply);
  expect(quote).not.toBeNull();
  const sourceUrl = new URL(quote!.source_url);
  expect(sourceUrl.protocol).toBe("https:");
  await artifacts.writeJson(`actions/${args.label}-assessment.json`, assessmentArtifact);
  return {
    assessment: assessmentArtifact,
    quote: {
      as_of: quote!.as_of,
      price: quote!.price,
      source: { hostname: sourceUrl.hostname.toLowerCase(), protocol: "https:" },
      status: quote!.status,
      symbol: quote!.symbol,
    },
  };
}
