// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";

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
  projectOpenClawAgentFailureArtifact,
  projectPersonalPublicFetchToolEvidenceArtifact,
  runOpenClawAgentAssertionRetry,
  text,
  type OpenClawPublicFetchExpectation,
  type OpenClawToolEvidence,
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
  label: string;
  prompt: string;
  persistCommandArtifacts?: boolean;
  publicFetchExpectation?: OpenClawPublicFetchExpectation;
  redactOutputInFailure?: boolean;
  sandboxName: string;
  toolEvidenceValidator?: (evidence: OpenClawToolEvidence) => boolean;
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
  if (args.toolEvidenceValidator && !args.publicFetchExpectation) {
    throw new Error(`${args.label}: tool evidence validation requires a public fetch expectation`);
  }
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
      const recordAttemptEvidence = async (path: string, evidence: unknown): Promise<void> => {
        const write = artifacts.writeJson(path, evidence);
        // Required success evidence retains its original write failure.
        // Failed-turn diagnostics must preserve the original retry classification.
        await (classification.passed ? write : write.catch(() => undefined));
      };
      if (!classification.passed && args.persistCommandArtifacts === false) {
        await recordAttemptEvidence(
          `actions/${args.label}-attempt-${attempt}-agent-failure.json`,
          projectOpenClawAgentFailureArtifact(attempt, classification, agent),
        );
      }
      const validation = await validateOpenClawAgentAttemptEvidence({
        classification,
        collectToolEvidence: args.publicFetchExpectation !== undefined && !classification.passed,
        label: args.label,
        recordToolEvidenceReductionFailure: async (failure) => {
          await recordAttemptEvidence(
            `actions/${args.label}-attempt-${attempt}-reducer-failure.json`,
            failure,
          );
        },
        recordToolEvidence: async (toolEvidence) => {
          await recordAttemptEvidence(
            `actions/${args.label}-attempt-${attempt}-reduced.json`,
            projectPersonalPublicFetchToolEvidenceArtifact(toolEvidence),
          );
        },
        reduceToolEvidence: async () =>
          sandbox.exec(
            args.sandboxName,
            [
              "node",
              "-e",
              buildOpenClawToolEvidenceReducerScript(args.publicFetchExpectation),
              OPENCLAW_MAIN_AGENT_DATABASE,
              sessionId,
            ],
            {
              env: commandEnv(),
              persistArtifacts: false,
              timeoutMs: 30_000,
            },
          ),
        reply,
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
  }).finally(() => {
    temporarySshConfig.cleanup();
    if (existsSync(temporarySshConfig.dir)) {
      throw new Error(`${args.label}: failed to remove temporary OpenShell SSH configuration`);
    }
  });
  if (execution.outcome === "passed" && successfulEvidence) return successfulEvidence;
  if (args.publicFetchExpectation) {
    await capturePublicFetchFailureProbe(
      sandbox,
      artifacts,
      args.sandboxName,
      args.label,
      args.publicFetchExpectation.url,
    );
  }
  throw new Error(`${args.label}: expected ${args.expected}, got ${lastFailure}`);
}

/** A separate request can corroborate reachability, but cannot prove the tool request's response. */
export async function capturePublicFetchFailureProbe(
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  sandboxName: string,
  label: string,
  url: string,
): Promise<void> {
  const observedAt = new Date().toISOString();
  try {
    const result = await sandbox.exec(
      sandboxName,
      [
        "curl",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--max-time",
        "15",
        "--max-redirs",
        "0",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        "--",
        url,
      ],
      { env: commandEnv(), persistArtifacts: false, timeoutMs: 20_000 },
    );
    await artifacts.writeJson(`actions/${label}-separate-http-probe.json`, {
      schemaVersion: 1,
      source: "separate-sandbox-curl-request",
      observedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      httpStatus: /^[1-5][0-9]{2}$/.test(result.stdout.trim())
        ? Number(result.stdout.trim())
        : null,
    });
  } catch {
    try {
      await artifacts.writeJson(`actions/${label}-separate-http-probe.json`, {
        schemaVersion: 1,
        source: "separate-sandbox-curl-request",
        observedAt,
        unavailable: true,
      });
    } catch {
      // Preserve the original assertion when diagnostics cannot be saved.
    }
  }
}
