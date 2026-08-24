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
const MAX_LATEST_STOCK_AGE_MS = 8 * 24 * 60 * 60_000;
const MAX_SOURCE_CLOCK_SKEW_MS = 36 * 60 * 60_000;

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
  asOfRecent: true;
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
Choose a small, machine-readable public HTTPS source yourself and use web_fetch as the only target tool.
If progressive tool disclosure is active, you may use tool_search, tool_describe, and tool_call only to discover and invoke web_fetch.
Do not invoke any other target tool. Do not use web_search, Brave Search, or Tavily Search.
Set web_fetch maxChars to no more than 8000.
Only after web_fetch returns a numeric NVDA price with its source date or timestamp, reply with one JSON object and no Markdown.
Set status to NVDA_PERSONAL_AGENT_OK, symbol to NVDA, price to a JSON number, source_url to the exact HTTPS URL passed to web_fetch, and as_of to the quote's own market or update timestamp converted to ISO 8601.
For a Unix-epoch quote field such as regularMarketTime, convert that field to ISO 8601. Never use the current clock, fetch time, or an unrelated date for as_of.`;

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
  const quoteTime = Date.parse(quote!.as_of);
  const now = Date.now();
  expect(quoteTime).toBeGreaterThanOrEqual(now - MAX_LATEST_STOCK_AGE_MS);
  expect(quoteTime).toBeLessThanOrEqual(now + MAX_SOURCE_CLOCK_SKEW_MS);
  const sourceUrl = new URL(quote!.source_url);
  expect(sourceUrl.protocol).toBe("https:");
  await artifacts.writeJson(`actions/${args.label}-assessment.json`, assessmentArtifact);
  return {
    assessment: assessmentArtifact,
    asOfRecent: true,
    quote: {
      as_of: quote!.as_of,
      price: quote!.price,
      source: { hostname: sourceUrl.hostname.toLowerCase(), protocol: "https:" },
      status: quote!.status,
      symbol: quote!.symbol,
    },
  };
}
