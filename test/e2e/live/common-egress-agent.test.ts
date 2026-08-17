// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe } from "vitest";
import YAML from "yaml";

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
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
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  assessPersonalStockToolEvidence,
  buildOpenClawToolEvidenceReducerScript,
  classifyHermesAgentAssertion,
  classifyOpenClawAgentAssertion,
  classifyPreContractProviderValidationSkip,
  COMMON_EGRESS_TEST_TIMEOUT_MS,
  nvdaPersonalStockReplyMatchesEvidence,
  parseChatContent,
  parseNvdaPersonalStockReply,
  parseOpenClawAgentText,
  parseOpenClawToolEvidence,
  type OpenClawToolEvidence,
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
} from "./common-egress-agent-helpers.ts";
import { stripAnsi } from "./json-envelope.ts";

//
// Preserve the legacy live boundary: real NemoClaw onboard, real OpenShell
// policy inspection, real OpenClaw SSH agent turns, and the Hermes API-server
// agent path. Helpers stay local because this test is a focused migration of
// one bash script, not a new shared e2e framework.

const OPENCLAW_BALANCED_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_OPENCLAW_BALANCED_SANDBOX ?? "e2e-oc-bal";
const OPENCLAW_OPEN_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_OPENCLAW_OPEN_SANDBOX ?? "e2e-oc-open";
const OPENCLAW_PERSONAL_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_OPENCLAW_PERSONAL_SANDBOX ?? "e2e-oc-personal";
const HERMES_SANDBOX = process.env.NEMOCLAW_COMMON_EGRESS_HERMES_SANDBOX ?? "e2e-hm-open";
const CHAT_MODEL = process.env.NEMOCLAW_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const AGENT_TURN_TIMEOUT_MS = 3 * 60_000;
const HERMES_AGENT_TIMEOUT_MS = 150_000;
const OPENCLAW_AGENT_ATTEMPTS = 3;
const HERMES_AGENT_ATTEMPTS = 3;
const KEEP_SANDBOX =
  process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1" ||
  process.env.NEMOCLAW_COMMON_EGRESS_KEEP_SANDBOX === "1";

validateSandboxName(OPENCLAW_BALANCED_SANDBOX);
validateSandboxName(OPENCLAW_OPEN_SANDBOX);
validateSandboxName(OPENCLAW_PERSONAL_SANDBOX);
validateSandboxName(HERMES_SANDBOX);

type NemoEnv = NodeJS.ProcessEnv;
type SkipFn = (note?: string) => never;

interface CleanupAttempt {
  exitCode: number | null;
  missingSandboxTolerated: boolean;
  outputTail: string;
}

interface CleanupSummary {
  nemoclawDestroy?: CleanupAttempt;
  openshellDelete?: CleanupAttempt;
  errors: string[];
}

interface ActivePolicyPreset {
  name: string;
  provenance: string;
}

interface OpenClawAgentAssertionEvidence {
  reply: string;
  toolEvidence?: OpenClawToolEvidence;
}

function text(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function tail(value: string, length = 4_000): string {
  return value.length > length ? value.slice(-length) : value;
}

function commandEnv(extra: NemoEnv = {}): NemoEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

function httpStatusFromResponse(raw: string): string {
  return (
    raw
      .split("\n")
      .filter((line) => line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
      .at(-1)
      ?.replace("__NEMOCLAW_HTTP_STATUS__=", "")
      .trim() || "000"
  );
}

function httpBodyFromResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("__NEMOCLAW_HTTP_STATUS__="))
    .join("\n")
    .trim();
}

function isMissingSandboxOutput(output: string): boolean {
  return /Sandbox .* does not exist|sandbox .* does not exist|does not exist|not found|No such sandbox/i.test(
    output,
  );
}

function cleanupAttempt(result: ShellProbeResult): CleanupAttempt {
  const output = text(result);
  return {
    exitCode: result.exitCode,
    missingSandboxTolerated: result.exitCode !== 0 && isMissingSandboxOutput(output),
    outputTail: tail(output, 2_000),
  };
}

async function assertPrerequisites(
  host: HostCliClient,
  secrets: SecretStore,
  skip: SkipFn,
): Promise<HostedInferenceConfig> {
  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-common-egress",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for common-egress agent E2E: ${text(docker)}`);
    }
    skip("Docker is required for common-egress agent E2E");
  }

  const openshell = await host.command("openshell", ["--version"], {
    artifactName: "prereq-openshell-version-common-egress",
    env: commandEnv(),
    timeoutMs: 30_000,
  });
  expect(openshell.exitCode, text(openshell)).toBe(0);

  const hosted = requireHostedInferenceConfig(secrets);
  expect(process.env.NEMOCLAW_NON_INTERACTIVE, "NEMOCLAW_NON_INTERACTIVE=1 is required").toBe("1");
  expect(
    process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE,
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required",
  ).toBe("1");
  return hosted;
}

async function bestEffortPrecleanSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<CleanupSummary> {
  const result: CleanupSummary = { errors: [] };
  try {
    const destroy = await host.command("node", [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
      artifactName: `${artifactPrefix}-nemoclaw-destroy-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    result.nemoclawDestroy = cleanupAttempt(destroy);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const deleted = await sandbox.openshell(["sandbox", "delete", sandboxName], {
      artifactName: `${artifactPrefix}-openshell-delete-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    });
    result.openshellDelete = cleanupAttempt(deleted);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  return result;
}

async function registerSandboxCleanup(
  cleanup: CleanupRegistry,
  artifacts: ArtifactSink,
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  if (KEEP_SANDBOX) {
    await artifacts.writeJson(`keep-sandbox-${sandboxName}.json`, {
      sandboxName,
      reason: "NEMOCLAW_E2E_KEEP_SANDBOX or NEMOCLAW_COMMON_EGRESS_KEEP_SANDBOX is set",
    });
    return;
  }
  const summary: CleanupSummary = { errors: [] };
  cleanup.trackDisposable(`write common-egress cleanup summary for ${sandboxName}`, async () => {
    await artifacts.writeJson(`cleanup-common-egress-${sandboxName}.json`, summary);
  });
  cleanup.trackDisposable(`delete common-egress OpenShell sandbox ${sandboxName}`, async () => {
    try {
      await sandbox.cleanupSandbox(sandboxName, {
        artifactName: `cleanup-openshell-delete-${sandboxName}`,
        env: commandEnv(),
        timeoutMs: 60_000,
      });
      summary.openshellDelete = {
        exitCode: 0,
        missingSandboxTolerated: false,
        outputTail: "",
      };
    } catch (error) {
      summary.errors.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  cleanup.trackDisposable(`destroy common-egress sandbox ${sandboxName}`, async () => {
    const destroy = await host.command("node", [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
      artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 120_000,
    });
    const attempt = cleanupAttempt(destroy);
    summary.nemoclawDestroy = attempt;
    try {
      assertCleanupSucceededOrAbsent(
        destroy,
        attempt.missingSandboxTolerated,
        `cleanup destroy sandbox ${sandboxName}`,
      );
    } catch (error) {
      summary.errors.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  const precleanSummary = await bestEffortPrecleanSandbox(
    host,
    sandbox,
    sandboxName,
    "pre-cleanup",
  );
  await artifacts.writeJson(`pre-cleanup-common-egress-${sandboxName}.json`, precleanSummary);
}

async function runOnboard(
  host: HostCliClient,
  args: {
    agent: "openclaw" | "hermes";
    artifacts: ArtifactSink;
    hosted: HostedInferenceConfig;
    sandboxName: string;
    skip: SkipFn;
    tier: "balanced" | "open" | "personal";
    extraEnv?: NemoEnv;
    extraRedactionValues?: string[];
  },
): Promise<ShellProbeResult> {
  const onboard = await host.command(
    "node",
    [
      CLI_ENTRYPOINT,
      "onboard",
      "--fresh",
      "--non-interactive",
      "--yes-i-accept-third-party-software",
    ],
    {
      artifactName: `onboard-common-egress-${args.sandboxName}`,
      cwd: REPO_ROOT,
      env: commandEnv({
        ...args.hosted.env,
        ...args.extraEnv,
        NEMOCLAW_AGENT: args.agent,
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_POLICY_TIER: args.tier,
        NEMOCLAW_SANDBOX_NAME: args.sandboxName,
      }),
      redactionValues: [args.hosted.apiKey, ...(args.extraRedactionValues ?? [])],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  const preContractProviderSkip = classifyPreContractProviderValidationSkip(onboard);
  if (onboard.exitCode !== 0 && preContractProviderSkip.matches) {
    // Invalid state: external NVIDIA endpoint validation failed before the
    // migrated common-egress contract reached sandbox policy or agent checks.
    // Source boundary: hosted provider availability/rate limiting outside this
    // repo. Removal condition: endpoint validation becomes stable in CI for a
    // release cycle or NemoClaw gains a hermetic provider-validation fixture.
    await args.artifacts.writeJson(`onboard-common-egress-${args.sandboxName}.skip.json`, {
      id: "common-egress-agent",
      sandboxName: args.sandboxName,
      status: "skipped",
      reason: "provider-validation-unavailable-before-common-egress-contract",
      sourceBoundary: "external NVIDIA Endpoints validation before sandbox common-egress contract",
      removalCondition:
        "remove once CI endpoint validation is stable for a release cycle or covered by a hermetic provider-validation fixture",
      classifier: preContractProviderSkip,
      onboardExitCode: onboard.exitCode,
      onboardSignal: onboard.signal,
      onboardTimedOut: onboard.timedOut,
      stdoutTail: tail(onboard.stdout),
      stderrTail: tail(onboard.stderr),
    });
    args.skip(
      "NVIDIA endpoint validation was unavailable/rate-limited before common-egress assertions",
    );
  }
  expect(onboard.exitCode, text(onboard)).toBe(0);
  return onboard;
}

async function assertPolicyContains(
  sandbox: SandboxClient,
  sandboxName: string,
  label: string,
  needles: string[],
): Promise<void> {
  const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
    artifactName: `policy-get-${label}`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, text(policy)).toBe(0);
  const output = text(policy);
  for (const needle of needles) {
    expect(output, `${label}: missing policy entry ${needle}`).toContain(needle);
  }
}

async function assertPolicyAbsent(
  sandbox: SandboxClient,
  sandboxName: string,
  label: string,
  needle: string,
): Promise<void> {
  const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
    artifactName: `policy-get-${label}`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, text(policy)).toBe(0);
  expect(text(policy), `${label}: unexpected policy entry ${needle}`).not.toContain(needle);
}

async function assertPersonalOwnsAllWebPorts(
  sandbox: SandboxClient,
  sandboxName: string,
): Promise<void> {
  const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
    artifactName: "policy-get-c4-personal-web-port-authority",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, text(policy)).toBe(0);
  const document = YAML.parse(parseOpenShellPolicy(policy.stdout).yamlBody) as {
    network_policies?: Record<
      string,
      { endpoints?: Array<{ port?: number | string; ports?: Array<number | string> }> }
    >;
  };
  const webPortClaims = Object.entries(document.network_policies ?? {})
    .flatMap(([policyName, entry]) =>
      (entry.endpoints ?? []).flatMap((endpoint) => {
        const ports = endpoint.ports ?? (endpoint.port === undefined ? [] : [endpoint.port]);
        return ports
          .map(Number)
          .filter((port) => port === 80 || port === 443)
          .map((port) => ({ policy: policyName, port }));
      }),
    )
    .sort((left, right) => left.policy.localeCompare(right.policy) || left.port - right.port);
  expect(webPortClaims).toEqual([
    { policy: "personal_open_internet", port: 80 },
    { policy: "personal_open_internet", port: 443 },
  ]);
}

async function listActivePolicyPresets(
  host: HostCliClient,
  sandboxName: string,
  label: string,
): Promise<ActivePolicyPreset[]> {
  const result = await host.command("node", [CLI_ENTRYPOINT, sandboxName, "policy-list"], {
    artifactName: `policy-list-${label}`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(result.exitCode, text(result)).toBe(0);
  return stripAnsi(text(result))
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = line.match(/^\s*●\s+([a-z0-9-]+)\s+\[([^\]]+)\]/iu);
      return match?.[1] && match[2]
        ? [{ name: match[1].toLowerCase(), provenance: match[2].toLowerCase() }]
        : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function addPolicyPreset(
  host: HostCliClient,
  sandboxName: string,
  preset: string,
): Promise<void> {
  const result = await host.command(
    "node",
    [CLI_ENTRYPOINT, sandboxName, "policy-add", preset, "--yes"],
    {
      artifactName: `policy-add-${preset}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(result.exitCode, text(result)).toBe(0);
  await sleep(2_000);
}

async function runOpenClawAgentAssertion(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  args: {
    apiKey: string;
    expected: string;
    label: string;
    prompt: string;
    replyValidator?: (reply: string, evidence?: OpenClawToolEvidence) => boolean;
    sandboxName: string;
    toolEvidenceValidator?: (evidence: OpenClawToolEvidence) => boolean;
  },
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
      await artifacts.writeJson(`retry/${args.label}-agent-retry-evidence.json`, evidence);
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
          redactionValues: [args.apiKey],
          timeoutMs: AGENT_TURN_TIMEOUT_MS,
        },
      );
      const combined = text(agent);
      const reply = parseOpenClawAgentText(agent.stdout);
      lastFailure = `reply='${reply.slice(0, 240)}' exit=${agent.exitCode} stdout='${agent.stdout.slice(
        0,
        240,
      )}' stderr='${agent.stderr.slice(0, 240)}'`;
      const classification = classifyOpenClawAgentAssertion({
        exitCode: agent.exitCode,
        expected: args.expected,
        reply,
        response: combined,
      });
      if (!classification.passed) return classification;

      let toolEvidence: OpenClawToolEvidence | undefined;
      if (args.toolEvidenceValidator) {
        const expectedStock = parseNvdaPersonalStockReply(reply);
        if (!expectedStock) {
          lastFailure = `${args.label}: agent reply did not contain a valid stock quote`;
          return { passed: false, failureClass: "deterministic" };
        }
        const reduced = await sandbox.exec(
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
        );
        if (reduced.exitCode !== 0) {
          lastFailure = `reduced tool evidence exited with ${reduced.exitCode}`;
          return { passed: false, failureClass: "deterministic" };
        }
        try {
          toolEvidence = parseOpenClawToolEvidence(reduced.stdout);
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
          return { passed: false, failureClass: "deterministic" };
        }
        await artifacts.writeJson(
          `trajectory/${args.label}-attempt-${attempt}-reduced.json`,
          toolEvidence,
        );
        if (!args.toolEvidenceValidator(toolEvidence)) {
          lastFailure = `${args.label}: reduced tool evidence did not match the required trajectory`;
          return { passed: false, failureClass: "deterministic" };
        }
      }
      if (args.replyValidator && !args.replyValidator(reply, toolEvidence)) {
        lastFailure = `${args.label}: agent reply did not contain a recent fetched stock quote`;
        return { passed: false, failureClass: "deterministic" };
      }
      successfulEvidence = toolEvidence ? { reply, toolEvidence } : { reply };
      return { passed: true };
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

function buildHermesReferencePrompt(): string {
  return String.raw`Use your terminal tool to run this Python check exactly once:
python3 - <<'PY'
import json
import urllib.request

url = "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json"
with urllib.request.urlopen(url, timeout=20) as response:
    doc = json.load(response)
ok = doc.get("success") == 1 and doc.get("entities", {}).get("Q30", {}).get("labels", {}).get("en", {}).get("value") == "United States"
print("HERMES_REFERENCE_AGENT_OK" if ok else "HERMES_REFERENCE_AGENT_BAD")
PY
After the command completes, reply exactly HERMES_REFERENCE_AGENT_OK if that exact token appeared. Do not fetch any other URL.`;
}

async function runHermesAgentAssertion(
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  args: {
    expected: string;
    label: string;
    prompt: string;
    sandboxName: string;
  },
): Promise<void> {
  const payload = JSON.stringify({
    model: CHAT_MODEL,
    messages: [{ role: "user", content: args.prompt }],
    max_tokens: 300,
  });
  const remote = [
    "set -a",
    "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
    "set +a",
    "tmp=$(mktemp)",
    `if [ -n "\${API_SERVER_KEY:-}" ]; then code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY}" -d ${shellQuote(
      payload,
    )}); else code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d ${shellQuote(
      payload,
    )}); fi`,
    "rc=$?",
    'cat "$tmp"',
    'rm -f "$tmp"',
    `printf '\\n__NEMOCLAW_HTTP_STATUS__=%s\\n' "\${code:-000}"`,
    'exit "$rc"',
  ].join("; ");

  let lastFailure = "";
  const execution = await runHermesAgentAssertionRetry({
    attempts: HERMES_AGENT_ATTEMPTS,
    delayMs: () => 5_000,
    onEvidence: async (evidence) => {
      await artifacts.writeJson(`retry/${args.label}-agent-retry-evidence.json`, evidence);
    },
    run: async (attempt) => {
      const agent = await sandbox.execShell(args.sandboxName, trustedSandboxShellScript(remote), {
        artifactName: `${args.label}-hermes-agent-attempt-${attempt}`,
        env: commandEnv(),
        timeoutMs: HERMES_AGENT_TIMEOUT_MS,
      });
      const response = text(agent);
      const httpStatus = httpStatusFromResponse(response);
      const body = httpBodyFromResponse(response);
      let reply = "";
      try {
        reply = parseChatContent(body);
      } catch {
        reply = "";
      }
      lastFailure = `exit=${agent.exitCode} http=${httpStatus} reply='${reply.slice(
        0,
        240,
      )}' body='${body.slice(0, 240)}'`;
      return classifyHermesAgentAssertion({
        exitCode: agent.exitCode,
        expected: args.expected,
        httpStatus,
        reply,
        response,
      });
    },
  });
  if (execution.outcome === "passed") return;
  throw new Error(`${args.label}: expected ${args.expected}, got ${lastFailure}`);
}

const openClawTest = process.env.NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW === "1" ? test.skip : test;
const hermesTest = process.env.NEMOCLAW_COMMON_EGRESS_SKIP_HERMES === "1" ? test.skip : test;

describe.sequential("common-egress agent live targets", () => {
  openClawTest(
    "C1 OpenClaw balanced excludes weather until explicitly added, then permits a verified wttr.in curl",
    {
      timeout: COMMON_EGRESS_TEST_TIMEOUT_MS,
      meta: {
        e2ePhases: [
          "validate hosted OpenClaw prerequisites",
          "onboard balanced-policy OpenClaw sandbox",
          "verify balanced egress excludes weather",
          "add weather egress policy",
          "run verified weather agent turn",
        ],
      },
    },
    async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
      const hosted = await assertPrerequisites(host, secrets, skip);
      const apiKey = hosted.apiKey;
      const braveApiKey = secrets.required("BRAVE_API_KEY");
      await artifacts.target.declare({
        id: "common-egress-agent",
        case: "openclaw-balanced-weather",
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        contract: [
          "OpenClaw balanced onboarding applies exactly six expected presets without weather",
          "explicit policy-add weather applies the weather common-egress endpoints",
          "balanced scope does not include the broader restcountries public-reference endpoint",
          "a real OpenClaw agent turn validates one wttr.in response and leaves its body as proof",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, OPENCLAW_BALANCED_SANDBOX);
      progress.phase("onboard balanced-policy OpenClaw sandbox");
      await runOnboard(host, {
        agent: "openclaw",
        artifacts,
        hosted,
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        skip,
        tier: "balanced",
        extraEnv: { BRAVE_API_KEY: braveApiKey },
        extraRedactionValues: [braveApiKey],
      });

      progress.phase("verify balanced egress excludes weather");
      expect(
        await listActivePolicyPresets(host, OPENCLAW_BALANCED_SANDBOX, "c1-balanced-initial"),
      ).toEqual([
        { name: "brave", provenance: "from balanced tier" },
        { name: "brew", provenance: "from balanced tier" },
        { name: "huggingface", provenance: "from balanced tier" },
        { name: "npm", provenance: "from balanced tier" },
        { name: "openclaw-pricing", provenance: "from openclaw agent" },
        { name: "pypi", provenance: "from balanced tier" },
      ]);
      await assertPolicyAbsent(
        sandbox,
        OPENCLAW_BALANCED_SANDBOX,
        "c1-weather-before-add",
        "wttr.in",
      );

      progress.phase("add weather egress policy");
      await addPolicyPreset(host, OPENCLAW_BALANCED_SANDBOX, "weather");
      expect(
        await listActivePolicyPresets(host, OPENCLAW_BALANCED_SANDBOX, "c1-after-weather-add"),
      ).toEqual([
        { name: "brave", provenance: "from balanced tier" },
        { name: "brew", provenance: "from balanced tier" },
        { name: "huggingface", provenance: "from balanced tier" },
        { name: "npm", provenance: "from balanced tier" },
        { name: "openclaw-pricing", provenance: "from openclaw agent" },
        { name: "pypi", provenance: "from balanced tier" },
        { name: "weather", provenance: "user-added" },
      ]);
      await assertPolicyContains(sandbox, OPENCLAW_BALANCED_SANDBOX, "c1-policy", [
        "api.open-meteo.com",
        "geocoding-api.open-meteo.com",
        "wttr.in",
      ]);
      await assertPolicyAbsent(
        sandbox,
        OPENCLAW_BALANCED_SANDBOX,
        "c1-balanced-scope",
        "restcountries.com",
      );
      const weatherProofPath = `/tmp/nemoclaw-weather-proof-${Date.now()}-${process.pid}.txt`;
      const clearWeatherProof = await sandbox.execShell(
        OPENCLAW_BALANCED_SANDBOX,
        trustedSandboxShellScript(`rm -f ${shellQuote(weatherProofPath)}`),
        {
          artifactName: "c1-weather-clear-proof",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(clearWeatherProof.exitCode, text(clearWeatherProof)).toBe(0);
      progress.phase("run verified weather agent turn");
      // The agent must leave the fetched body behind. The host-side assertion
      // independently validates it, so merely echoing the reply token cannot pass.
      const weatherProofCommand = [
        "set -eu",
        `proof=${shellQuote(weatherProofPath)}`,
        "if test -s \"$proof\"; then printf 'WEATHER_AGENT_OK\\n'; exit 0; fi",
        "tmp=$(mktemp)",
        "trap 'rm -f \"$tmp\"' EXIT",
        "curl -fsS --max-time 30 --output \"$tmp\" 'https://wttr.in/:help'",
        'test -s "$tmp"',
        "grep -Fq 'Usage:' \"$tmp\"",
        "grep -Fq 'Special URLs:' \"$tmp\"",
        'mv "$tmp" "$proof"',
        "trap - EXIT",
        "printf 'WEATHER_AGENT_OK\\n'",
      ].join("; ");
      await runOpenClawAgentAssertion(host, sandbox, artifacts, {
        apiKey,
        expected: "WEATHER_AGENT_OK",
        label: "c1-agent-weather",
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        prompt: `Run exactly this shell command to verify the weather host curl path:
${weatherProofCommand}
Do not use web_fetch, web_search, or any other weather provider.
After it returns, reply with only WEATHER_AGENT_OK. Do not fetch any other URL.`,
      });
      const weatherProof = await sandbox.execShell(
        OPENCLAW_BALANCED_SANDBOX,
        trustedSandboxShellScript(
          `test -s ${shellQuote(weatherProofPath)} && grep -Fq 'Usage:' ${shellQuote(weatherProofPath)} && grep -Fq 'Special URLs:' ${shellQuote(weatherProofPath)} && sha256sum ${shellQuote(weatherProofPath)}`,
        ),
        {
          artifactName: "c1-weather-agent-proof",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(weatherProof.exitCode, text(weatherProof)).toBe(0);
      expect(weatherProof.stdout.trim()).toMatch(/^[a-f0-9]{64}\s+/);
      await artifacts.target.complete({
        id: "common-egress-agent",
        case: "openclaw-balanced-weather",
        status: "passed",
      });
    },
  );

  openClawTest(
    "C2 OpenClaw open includes public reference and agent fetches Wikidata",
    {
      timeout: COMMON_EGRESS_TEST_TIMEOUT_MS,
      meta: {
        e2ePhases: [
          "validate hosted OpenClaw prerequisites",
          "onboard open-policy OpenClaw sandbox",
          "verify public-reference egress policy",
          "fetch Wikidata with OpenClaw agent",
        ],
      },
    },
    async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
      const hosted = await assertPrerequisites(host, secrets, skip);
      const apiKey = hosted.apiKey;
      await artifacts.target.declare({
        id: "common-egress-agent",
        case: "openclaw-open-public-reference",
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        contract: [
          "OpenClaw open onboarding applies public-reference common-egress endpoints",
          "a real OpenClaw agent turn fetches Wikidata through web_fetch",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, OPENCLAW_OPEN_SANDBOX);
      progress.phase("onboard open-policy OpenClaw sandbox");
      await runOnboard(host, {
        agent: "openclaw",
        artifacts,
        hosted,
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        skip,
        tier: "open",
      });
      progress.phase("verify public-reference egress policy");
      await assertPolicyContains(sandbox, OPENCLAW_OPEN_SANDBOX, "c2-policy", [
        "www.wikidata.org",
        "nominatim.openstreetmap.org",
        "query.wikidata.org",
      ]);
      progress.phase("fetch Wikidata with OpenClaw agent");
      await runOpenClawAgentAssertion(host, sandbox, artifacts, {
        apiKey,
        expected: "REFERENCE_AGENT_OK",
        label: "c2-agent-reference",
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        prompt: `Use the web_fetch tool to fetch exactly this URL:
https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json
After web_fetch returns, reply exactly REFERENCE_AGENT_OK if the fetched response says entity Q30 has the English label United States. Do not fetch any other URL.`,
      });
      await artifacts.target.complete({
        id: "common-egress-agent",
        case: "openclaw-open-public-reference",
        status: "passed",
      });
    },
  );

  hermesTest(
    "C3 Hermes open includes public reference plus Nous presets and agent fetches Wikidata",
    {
      timeout: COMMON_EGRESS_TEST_TIMEOUT_MS,
      meta: {
        e2ePhases: [
          "validate hosted Hermes prerequisites",
          "onboard open-policy Hermes sandbox",
          "verify public-reference and Nous egress",
          "fetch Wikidata with Hermes agent",
        ],
      },
    },
    async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
      const hosted = await assertPrerequisites(host, secrets, skip);
      const apiKey = hosted.apiKey;
      await artifacts.target.declare({
        id: "common-egress-agent",
        case: "hermes-open-public-reference",
        sandboxName: HERMES_SANDBOX,
        contract: [
          "Hermes open onboarding applies public-reference common-egress endpoints",
          "Hermes open onboarding applies all Hermes Nous managed-tool policy presets",
          "the Hermes API-server agent path fetches Wikidata through its terminal tool",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, HERMES_SANDBOX);
      progress.phase("onboard open-policy Hermes sandbox");
      await runOnboard(host, {
        agent: "hermes",
        artifacts,
        hosted,
        sandboxName: HERMES_SANDBOX,
        skip,
        tier: "open",
      });
      progress.phase("verify public-reference and Nous egress");
      await assertPolicyContains(sandbox, HERMES_SANDBOX, "c3-common-policy", [
        "www.wikidata.org",
        "api.open-meteo.com",
      ]);
      await assertPolicyContains(sandbox, HERMES_SANDBOX, "c3-hermes-nous-policy", [
        "/firecrawl",
        "/fal-queue",
        "/openai-audio",
        "/browser-use",
        "/modal",
      ]);
      progress.phase("fetch Wikidata with Hermes agent");
      await runHermesAgentAssertion(sandbox, artifacts, {
        expected: "HERMES_REFERENCE_AGENT_OK",
        label: "c3-agent-reference",
        prompt: buildHermesReferencePrompt(),
        sandboxName: HERMES_SANDBOX,
      });
      await artifacts.target.complete({
        id: "common-egress-agent",
        case: "hermes-open-public-reference",
        status: "passed",
      });
    },
  );

  openClawTest(
    "C4 OpenClaw Personal reaches public websites with keyless fetch and returns an NVDA quote",
    {
      timeout: COMMON_EGRESS_TEST_TIMEOUT_MS,
      meta: {
        e2ePhases: [
          "validate hosted OpenClaw prerequisites",
          "onboard Personal-policy OpenClaw sandbox without web search",
          "verify Personal policy and provider-free fetch state",
          "fetch a public website with curl and Python",
          "deny loopback and link-local targets",
          "fetch the latest NVDA quote with OpenClaw web fetch",
        ],
      },
    },
    async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
      const hosted = await assertPrerequisites(host, secrets, skip);
      const apiKey = hosted.apiKey;
      await artifacts.target.declare({
        id: "common-egress-agent",
        case: "openclaw-personal-stock-price",
        sandboxName: OPENCLAW_PERSONAL_SANDBOX,
        contract: [
          "OpenClaw Personal onboarding applies one broad public web policy for every sandbox binary",
          "curl and Python fetch a public website without a Brave Search or Tavily Search API key",
          "the Personal policy does not permit loopback or link-local web targets",
          "a real OpenClaw agent chooses a public source and fetches a recent NVDA price through web_fetch",
          "the reduced agent trajectory contains no web_search, Brave Search, or Tavily Search call",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, OPENCLAW_PERSONAL_SANDBOX);

      progress.phase("onboard Personal-policy OpenClaw sandbox without web search");
      await runOnboard(host, {
        agent: "openclaw",
        artifacts,
        hosted,
        sandboxName: OPENCLAW_PERSONAL_SANDBOX,
        skip,
        tier: "personal",
        extraEnv: {
          BRAVE_API_KEY: "",
          NEMOCLAW_POLICY_PRESETS: "",
          NEMOCLAW_WEB_SEARCH_ENABLED: "0",
          NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
          TAVILY_API_KEY: "",
        },
      });

      progress.phase("verify Personal policy and provider-free fetch state");
      expect(
        await listActivePolicyPresets(host, OPENCLAW_PERSONAL_SANDBOX, "c4-personal-initial"),
      ).toContainEqual({ name: "personal-open-internet", provenance: "from personal tier" });
      await assertPolicyContains(sandbox, OPENCLAW_PERSONAL_SANDBOX, "c4-personal-policy", [
        "personal_open_internet",
        "169.255.0.0/16",
        "2000::/3",
      ]);
      await assertPersonalOwnsAllWebPorts(sandbox, OPENCLAW_PERSONAL_SANDBOX);
      await assertPolicyAbsent(
        sandbox,
        OPENCLAW_PERSONAL_SANDBOX,
        "c4-no-brave-policy",
        "api.search.brave.com",
      );
      await assertPolicyAbsent(
        sandbox,
        OPENCLAW_PERSONAL_SANDBOX,
        "c4-no-tavily-policy",
        "api.tavily.com",
      );
      const keyless = await sandbox.execShell(
        OPENCLAW_PERSONAL_SANDBOX,
        trustedSandboxShellScript(
          'test -z "${BRAVE_API_KEY:-}" && test -z "${TAVILY_API_KEY:-}" && printf "PERSONAL_KEYLESS_FETCH_OK\\n"',
        ),
        {
          artifactName: "c4-personal-keyless-fetch",
          env: commandEnv(),
          timeoutMs: 30_000,
        },
      );
      expect(keyless.exitCode, text(keyless)).toBe(0);
      expect(keyless.stdout).toContain("PERSONAL_KEYLESS_FETCH_OK");

      progress.phase("fetch a public website with curl and Python");
      const multiBinary = await sandbox.execShell(
        OPENCLAW_PERSONAL_SANDBOX,
        trustedSandboxShellScript(String.raw`
set -eu
curl_bin="$(command -v curl)"
python_bin="$(command -v python3)"
test -n "$curl_bin"
test -n "$python_bin"
test "$curl_bin" != "$python_bin"
curl_body="$(mktemp)"
trap 'rm -f "$curl_body"' EXIT
"$curl_bin" -fsSL --max-time 30 -o "$curl_body" https://example.com/
grep -Fq 'Example Domain' "$curl_body"
"$python_bin" -c 'import sys, urllib.request; body = urllib.request.urlopen(sys.argv[1], timeout=30).read(20000); raise SystemExit(0 if b"Example Domain" in body else 1)' https://example.com/
printf 'PERSONAL_PUBLIC_MULTI_BINARY_OK curl=%s python=%s\n' "$curl_bin" "$python_bin"
`),
        {
          artifactName: "c4-personal-public-multi-binary",
          env: commandEnv(),
          timeoutMs: 90_000,
        },
      );
      expect(multiBinary.exitCode, text(multiBinary)).toBe(0);
      expect(multiBinary.stdout).toContain("PERSONAL_PUBLIC_MULTI_BINARY_OK");

      progress.phase("deny loopback and link-local targets");
      const deniedTargets = await sandbox.execShell(
        OPENCLAW_PERSONAL_SANDBOX,
        trustedSandboxShellScript(String.raw`
set -eu
probe_denied() {
  label="$1"
  target="$2"
  body="/tmp/nemoclaw-c4-denial-$label.body"
  stderr="/tmp/nemoclaw-c4-denial-$label.stderr"
  rm -f "$body" "$stderr"
  set +e
  status="$(curl --noproxy '' -sS -o "$body" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$target" 2>"$stderr")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ "$status" != "403" ]; then
    printf 'PERSONAL_DENIAL_FAILED label=%s status=%s rc=%s\n' "$label" "$status" "$rc" >&2
    head -c 1000 "$body" 2>/dev/null || true
    head -c 1000 "$stderr" >&2 2>/dev/null || true
    rm -f "$body" "$stderr"
    return 1
  fi
  rm -f "$body" "$stderr"
  printf 'PERSONAL_DENIAL_OK label=%s status=%s rc=%s\n' "$label" "$status" "$rc"
}
probe_denied loopback http://127.0.0.1:80/
probe_denied link-local http://169.254.169.254/latest/meta-data/
`),
        {
          artifactName: "c4-personal-loopback-link-local-denial",
          env: commandEnv(),
          timeoutMs: 60_000,
        },
      );
      expect(deniedTargets.exitCode, text(deniedTargets)).toBe(0);
      expect(deniedTargets.stdout).toContain("PERSONAL_DENIAL_OK label=loopback");
      expect(deniedTargets.stdout).toContain("PERSONAL_DENIAL_OK label=link-local");

      progress.phase("fetch the latest NVDA quote with OpenClaw web fetch");
      const stockPrompt = `Find the latest available NVIDIA (NVDA) stock price.
Use web_fetch and choose a public HTTPS source yourself.
Use no other tool. Do not use web_search, Brave Search, or Tavily Search.
Set web_fetch maxChars to no more than 8000.
Only after web_fetch returns a numeric NVDA price with its source date or timestamp, reply with one JSON object and no Markdown.
Set status to NVDA_PERSONAL_AGENT_OK, symbol to NVDA, price to a JSON number, source_url to the exact HTTPS URL passed to web_fetch, and as_of to the source's ISO 8601 date or timestamp.`;
      expect(stockPrompt).not.toMatch(/\bhttps?:\/\//iu);
      const stock = await runOpenClawAgentAssertion(host, sandbox, artifacts, {
        apiKey,
        expected: "NVDA_PERSONAL_AGENT_OK",
        label: "c4-agent-personal-stock",
        prompt: stockPrompt,
        replyValidator: (reply, evidence) =>
          evidence !== undefined && nvdaPersonalStockReplyMatchesEvidence(reply, evidence),
        sandboxName: OPENCLAW_PERSONAL_SANDBOX,
        toolEvidenceValidator: (evidence) => assessPersonalStockToolEvidence(evidence).matches,
      });
      expect(stock.toolEvidence).toBeDefined();
      await artifacts.writeJson(
        "trajectory/c4-agent-personal-stock-assessment.json",
        assessPersonalStockToolEvidence(stock.toolEvidence!),
      );
      await artifacts.target.complete({
        id: "common-egress-agent",
        case: "openclaw-personal-stock-price",
        status: "passed",
      });
    },
  );
});
