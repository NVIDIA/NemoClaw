// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { isObjectRecord } from "../../../src/lib/core/json-types.ts";

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
  WEATHER_RESPONSE_VALIDATION_PYTHON,
  buildOpenClawToolEvidenceReducerScript,
  classifyOpenClawAgentAssertion,
  isUnavailableSearchReply,
  projectOpenClawAgentFailureArtifact,
  parseOpenClawToolEvidence,
  projectPersonalPublicFetchToolEvidenceArtifact,
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
  collectToolEvidenceOnFailure?: boolean;
  expected: string;
  failureWeatherProofPath?: string;
  finalReplyContract?: "unavailable-search" | "exact-token";
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
        args.finalReplyContract === "exact-token" &&
        (reply.trim() !== args.expected || finalVisibleReply.trim() !== args.expected)
      ) {
        classification = { passed: false, failureClass: "deterministic" };
        lastFailure = "payload and final visible reply must contain only the expected token";
      }
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
          await recordAttemptEvidence(
            `actions/${args.label}-attempt-${attempt}-failed-turn-trajectory.json`,
            diagnostic,
          );
        }
      }
      const validation = await validateOpenClawAgentAttemptEvidence({
        classification,
        collectToolEvidence:
          (args.publicFetchExpectation !== undefined ||
            args.collectToolEvidenceOnFailure === true) &&
          !classification.passed,
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
            args.toolEvidence?.project(toolEvidence) ??
              (args.publicFetchExpectation
                ? projectPersonalPublicFetchToolEvidenceArtifact(toolEvidence)
                : {
                    schemaVersion: 1,
                    errorCount: toolEvidence.errors.length,
                    finalStatusCount: toolEvidence.finalStatuses.length,
                    toolCallCount: toolEvidence.toolCalls.length,
                    toolExecutionCount: toolEvidence.toolExecutions.length,
                    toolResultCount: toolEvidence.toolResults.length,
                    execCalls: toolEvidence.toolCalls.filter(({ name }) => name === "exec").length,
                    execResults: toolEvidence.toolResults.filter(({ name }) => name === "exec")
                      .length,
                  }),
          );
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
  if (args.publicFetchExpectation) {
    await capturePublicFetchFailureProbe(
      sandbox,
      artifacts,
      args.sandboxName,
      args.label,
      args.publicFetchExpectation.url,
    );
  }
  if (args.failureWeatherProofPath) {
    await captureWeatherProofFailureProbe(
      sandbox,
      artifacts,
      args.sandboxName,
      args.failureWeatherProofPath,
    );
    await capturePublicFetchFailureProbe(
      sandbox,
      artifacts,
      args.sandboxName,
      args.label,
      "https://api.open-meteo.com/v1/forecast?latitude=37.7749&longitude=-122.4194&current=temperature_2m",
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
      { env: commandEnv(), persistArtifacts: false, captureLimitBytes: 1_024, timeoutMs: 20_000 },
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

/** Inspect public weather proof without accepting a failed agent turn or retaining response text. */
export async function captureWeatherProofFailureProbe(
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  sandboxName: string,
  proofPath: string,
): Promise<void> {
  const script = [
    "import hashlib,json,os,stat,sys",
    'receipt={"schemaVersion":1,"state":"unreadable","sha256":None}',
    "try:",
    "    fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)",
    '    with os.fdopen(fd,"rb") as stream:',
    "        info=os.fstat(stream.fileno())",
    "        if not stat.S_ISREG(info.st_mode):",
    '            receipt["state"]="non-regular"',
    "        elif info.st_size>65536:",
    '            receipt["state"]="oversized"',
    "        else:",
    "            body=stream.read(65537)",
    "            if len(body)>65536:",
    '                receipt["state"]="oversized"',
    "            else:",
    '                receipt["state"]="invalid"',
    `                exec(${JSON.stringify(WEATHER_RESPONSE_VALIDATION_PYTHON.replace("d=json.load(open(sys.argv[1]))", "d=json.loads(body)"))})`,
    '                receipt.update(state="valid",sha256=hashlib.sha256(body).hexdigest())',
    "except FileNotFoundError:",
    '    receipt["state"]="absent"',
    "except Exception:",
    "    pass",
    "print(json.dumps(receipt))",
  ].join("\n");
  let diagnostic: { schemaVersion: 1; state: string; sha256: string | null } = {
    schemaVersion: 1,
    state: "unavailable",
    sha256: null,
  };
  try {
    const result = await sandbox.exec(sandboxName, ["python3", "-c", script, proofPath], {
      env: commandEnv(),
      persistArtifacts: false,
      captureLimitBytes: 1_024,
      timeoutMs: 10_000,
    });
    const value: unknown = JSON.parse(result.stdout);
    if (
      result.exitCode === 0 &&
      isObjectRecord(value) &&
      value.schemaVersion === 1 &&
      typeof value.state === "string" &&
      ["absent", "unreadable", "non-regular", "oversized", "invalid", "valid"].includes(
        value.state,
      ) &&
      (value.state !== "valid" ||
        (typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)))
    ) {
      diagnostic = {
        schemaVersion: 1,
        state: value.state,
        sha256:
          value.state === "valid" &&
          typeof value.sha256 === "string" &&
          /^[a-f0-9]{64}$/.test(value.sha256)
            ? value.sha256
            : null,
      };
    }
  } catch {
    // An unavailable diagnostic cannot replace the failed agent turn.
  }
  try {
    await artifacts.writeJson("actions/c1-weather-failed-turn-proof.json", diagnostic);
  } catch {
    // Preserve the original assertion when the artifact sink is unavailable.
  }
}
