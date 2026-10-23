// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";

import {
  openClawFinalAgentResponse,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { createTempSshConfig } from "../../../src/lib/sandbox/temp-ssh-config.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { parseOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import {
  buildOpenClawToolEvidenceReducerScript,
  classifyOpenClawAgentAssertion,
  isUnavailableSearchReply,
  projectOpenClawAgentFailureArtifact,
  parseOpenClawToolEvidence,
  runOpenClawAgentAssertionRetry,
  text,
  type OpenClawPublicFetchExpectation,
  type OpenClawToolEvidence,
  type OpenClawToolEvidenceArtifact,
  validateOpenClawAgentAttemptEvidence,
} from "./common-egress-agent-helpers.ts";

const AGENT_TURN_TIMEOUT_MS = 3 * 60_000;
const OPENCLAW_AGENT_ATTEMPTS = 3;
const OPENCLAW_MAIN_AGENT_DATABASE = "/sandbox/.openclaw/agents/main/agent/openclaw-agent.sqlite";

export interface OpenClawAgentAssertionEvidence {
  reply: string;
  toolEvidence?: OpenClawToolEvidence;
}

export interface OpenClawAgentAssertionOptions {
  apiKey: string;
  expected: string;
  finalReplyContract?: "unavailable-search";
  label: string;
  prompt: string;
  persistCommandArtifacts?: boolean;
  publicFetchExpectation?: OpenClawPublicFetchExpectation;
  redactOutputInFailure?: boolean;
  /** Receives payload and final visible text, including failed attempts. */
  recordReplyEvidence?: (
    reply: string,
    attempt: number,
    finalVisibleReply: string,
  ) => Promise<void>;
  sandboxName: string;
  toolEvidence?: {
    validate: (evidence: OpenClawToolEvidence) => boolean;
    project: (evidence: OpenClawToolEvidence) => OpenClawToolEvidenceArtifact;
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
    persistArtifacts: false,
    timeoutMs: 30_000,
  });
  expect(
    sshConfig.exitCode,
    `OpenShell SSH configuration exited with ${String(sshConfig.exitCode)}`,
  ).toBe(0);
  const temporarySshConfig = createTempSshConfig(sshConfig.stdout, "nemoclaw-e2e-ssh-");

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
      const remoteCommand = `openclaw agent --agent main --json --thinking off --session-id ${shellQuote(
        sessionId,
      )} -m ${shellQuote(args.prompt)}`;
      const agent = await host.command(
        "ssh",
        [
          "-F",
          temporarySshConfig.file,
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
      const final = openClawFinalAgentResponse(parseOpenClawJsonDocuments(agent.stdout));
      const visible = final?.meta.finalAssistantVisibleText;
      const finalVisibleReply = typeof visible === "string" ? visible : "";
      await args.recordReplyEvidence?.(reply, attempt, finalVisibleReply);
      lastFailure = args.redactOutputInFailure
        ? `agent output omitted; exit=${agent.exitCode}`
        : `reply='${reply.slice(0, 240)}' exit=${agent.exitCode} stdout='${agent.stdout.slice(
            0,
            240,
          )}' stderr='${agent.stderr.slice(0, 240)}'`;
      let classification = classifyOpenClawAgentAssertion({
        exitCode: agent.exitCode,
        expected: args.expected,
        reply,
        response: combined,
      });
      if (
        classification.passed &&
        args.finalReplyContract === "unavailable-search" &&
        !isUnavailableSearchReply(finalVisibleReply)
      ) {
        classification = { passed: false, failureClass: "deterministic" };
        lastFailure = "final visible reply does not satisfy unavailable-search contract";
      }
      const reduceToolEvidence = () =>
        sandbox.exec(
          args.sandboxName,
          [
            "node",
            "-e",
            buildOpenClawToolEvidenceReducerScript(args.publicFetchExpectation),
            OPENCLAW_MAIN_AGENT_DATABASE,
            sessionId,
          ],
          { env: commandEnv(), persistArtifacts: false, timeoutMs: 30_000 },
        );
      if (!classification.passed && args.persistCommandArtifacts === false) {
        await artifacts.writeJson(
          `actions/${args.label}-attempt-${attempt}-agent-failure.json`,
          projectOpenClawAgentFailureArtifact(attempt, classification, agent),
        );
        if (args.toolEvidence) {
          // A timed-out command may have persisted progress without returning JSON.
          // Keep the read-only projection diagnostic; it cannot accept the failed turn.
          let diagnostic: {
            schemaVersion: 1;
            state: string;
            toolEvidence?: OpenClawToolEvidenceArtifact;
          } = { schemaVersion: 1, state: "command-failed" };
          try {
            const reduced = await reduceToolEvidence();
            if (reduced.exitCode === 0) {
              diagnostic.state = "output-invalid";
              try {
                diagnostic = {
                  schemaVersion: 1,
                  state: "collected",
                  toolEvidence: args.toolEvidence.project(
                    parseOpenClawToolEvidence(reduced.stdout),
                  ),
                };
              } catch {
                // Parser errors can contain private session data.
              }
            }
          } catch {
            diagnostic.state = "command-threw";
          }
          await artifacts.writeJson(
            `actions/${args.label}-attempt-${attempt}-failed-turn-trajectory.json`,
            diagnostic,
          );
        }
      }
      const validation = await validateOpenClawAgentAttemptEvidence({
        classification,
        label: args.label,
        recordToolEvidenceReductionFailure: async (failure) => {
          await artifacts.writeJson(
            `actions/${args.label}-attempt-${attempt}-reducer-failure.json`,
            failure,
          );
        },
        recordToolEvidence: async (toolEvidence) => {
          if (args.toolEvidence) {
            await artifacts.writeJson(
              `actions/${args.label}-attempt-${attempt}-reduced.json`,
              args.toolEvidence.project(toolEvidence),
            );
          }
        },
        reduceToolEvidence,
        reply,
        toolEvidenceValidator: args.toolEvidence?.validate,
        toolEvidenceProjector: args.toolEvidence?.project,
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
  }).finally(() => {
    temporarySshConfig.cleanup();
    if (existsSync(temporarySshConfig.dir)) {
      throw new Error(`${args.label}: failed to remove temporary OpenShell SSH configuration`);
    }
  });
  if (execution.outcome === "passed" && successfulEvidence) return successfulEvidence;
  throw new Error(`${args.label}: expected ${args.expected}, got ${lastFailure}`);
}
