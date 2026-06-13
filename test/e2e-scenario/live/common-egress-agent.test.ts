// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe } from "vitest";

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

// Migrated from test/e2e/test-common-egress-agent-e2e.sh.
//
// Preserve the legacy live boundary: real NemoClaw onboard, real OpenShell
// policy inspection, real OpenClaw SSH agent turns, and the Hermes API-server
// agent path. Helpers stay local because this test is a focused migration of
// one bash script, not a new shared e2e framework.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const OPENCLAW_BALANCED_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_OPENCLAW_BALANCED_SANDBOX ??
  "e2e-common-egress-openclaw-balanced";
const OPENCLAW_OPEN_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_OPENCLAW_OPEN_SANDBOX ?? "e2e-common-egress-openclaw-open";
const HERMES_SANDBOX =
  process.env.NEMOCLAW_COMMON_EGRESS_HERMES_SANDBOX ?? "e2e-common-egress-hermes-open";
const CHAT_MODEL = process.env.NEMOCLAW_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const ONBOARD_TIMEOUT_MS = 25 * 60_000;
const TEST_TIMEOUT_MS = 40 * 60_000;
const AGENT_TURN_TIMEOUT_MS = 3 * 60_000;
const HERMES_AGENT_TIMEOUT_MS = 150_000;
const OPENCLAW_AGENT_ATTEMPTS = 3;
const HERMES_AGENT_ATTEMPTS = 3;
const KEEP_SANDBOX =
  process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1" ||
  process.env.NEMOCLAW_COMMON_EGRESS_KEEP_SANDBOX === "1";

validateSandboxName(OPENCLAW_BALANCED_SANDBOX);
validateSandboxName(OPENCLAW_OPEN_SANDBOX);
validateSandboxName(HERMES_SANDBOX);

type NemoEnv = NodeJS.ProcessEnv;
type SkipFn = (note?: string) => never;

interface AgentJsonDoc {
  payloads?: Array<{ text?: unknown }>;
  result?: { payloads?: Array<{ text?: unknown }> };
}

interface ChatCompletionLike {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
    };
    text?: unknown;
  }>;
}

interface CommonEgressProviderValidationSkip {
  http429ProviderValidationFailure: boolean;
  matches: boolean;
  sanitizedEndpointValidationFailure: boolean;
  transientProviderValidationFailure: boolean;
}

interface CleanupAttempt {
  exitCode: number | null;
  missingSandboxTolerated: boolean;
  outputTail: string;
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

function parseAgentJsonDocs(raw: string): AgentJsonDoc[] {
  try {
    const parsed = JSON.parse(raw) as AgentJsonDoc | AgentJsonDoc[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Invalid state: `openclaw agent --json` has emitted both single JSON
    // documents and log-prefixed streams across versions. Source boundary:
    // OpenClaw CLI stdout framing inside the sandbox, outside this NemoClaw
    // migration. Source-fix constraint: keep this test local and legacy-script
    // compatible instead of rewriting shared fixtures or patching OpenClaw from
    // a migration PR. Removal condition: supported OpenClaw versions guarantee
    // a strict single JSON document with payload text on stdout.
  }

  const docs: AgentJsonDoc[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "{") continue;
    for (let end = index + 1; end <= raw.length; end += 1) {
      try {
        const parsed = JSON.parse(raw.slice(index, end)) as AgentJsonDoc | AgentJsonDoc[];
        docs.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        index = end - 1;
        break;
      } catch {
        // Keep extending the candidate slice until it becomes valid JSON.
      }
    }
  }
  return docs;
}

function parseOpenClawAgentText(raw: string): string {
  return parseAgentJsonDocs(raw)
    .flatMap((doc) => doc.payloads ?? doc.result?.payloads ?? [])
    .map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .trim();
}

function parseChatContent(raw: string): string {
  const doc = JSON.parse(raw) as ChatCompletionLike;
  const choice = doc.choices?.[0];
  const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? choice?.text;
  return typeof content === "string" ? content.trim() : "";
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

function isOpenClawPolicyBlock(output: string): boolean {
  return /SsrFBlockedError|Blocked hostname/i.test(output);
}

function isOpenClawScopeUpgradePending(output: string): boolean {
  return /scope upgrade pending approval|pairing required: device is asking for more scopes/i.test(
    output,
  );
}

function isOpenClawTransientAgentError(output: string): boolean {
  return /ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT|gateway unavailable|network connection error|DNS error|fetch failed|LLM request timed out|FailoverError|inference service unavailable|rawError=503/i.test(
    output,
  );
}

function classifyPreContractProviderValidationSkip(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
): CommonEgressProviderValidationSkip {
  const output = text(result);
  const providerValidation =
    /endpoint validation failed|failed to verify inference endpoint|Chat Completions API validation/i.test(
      output,
    );
  const transientProviderValidationFailure = isTransientProviderValidationFailure(result);
  const http429ProviderValidationFailure =
    providerValidation && /HTTP\s*429|\b429\b|rate[- ]?limit|too many requests/i.test(output);
  const sanitizedEndpointValidationFailure =
    providerValidation &&
    /Validation details were omitted to avoid exposing credentials/i.test(output) &&
    process.env.GITHUB_ACTIONS === "true";

  return {
    http429ProviderValidationFailure,
    matches:
      transientProviderValidationFailure ||
      http429ProviderValidationFailure ||
      sanitizedEndpointValidationFailure,
    sanitizedEndpointValidationFailure,
    transientProviderValidationFailure,
  };
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
): Promise<string> {
  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI scenarios",
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

  const apiKey = secrets.required("NVIDIA_API_KEY");
  expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);
  expect(process.env.NEMOCLAW_NON_INTERACTIVE, "NEMOCLAW_NON_INTERACTIVE=1 is required").toBe("1");
  expect(
    process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE,
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required",
  ).toBe("1");
  return apiKey;
}

async function bestEffortDestroySandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<{
  nemoclawDestroy?: CleanupAttempt;
  openshellDelete?: CleanupAttempt;
  errors: string[];
}> {
  const result: {
    nemoclawDestroy?: CleanupAttempt;
    openshellDelete?: CleanupAttempt;
    errors: string[];
  } = {
    errors: [],
  };
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
  cleanup.add(`destroy common-egress sandbox ${sandboxName}`, async () => {
    const summary = await bestEffortDestroySandbox(host, sandbox, sandboxName, "cleanup");
    await artifacts.writeJson(`cleanup-common-egress-${sandboxName}.json`, summary);
  });
  const summary = await bestEffortDestroySandbox(host, sandbox, sandboxName, "pre-cleanup");
  await artifacts.writeJson(`pre-cleanup-common-egress-${sandboxName}.json`, summary);
}

async function runOnboard(
  host: HostCliClient,
  args: {
    agent: "openclaw" | "hermes";
    apiKey: string;
    artifacts: ArtifactSink;
    sandboxName: string;
    skip: SkipFn;
    tier: "balanced" | "open";
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
        NVIDIA_API_KEY: args.apiKey,
        NEMOCLAW_AGENT: args.agent,
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_POLICY_TIER: args.tier,
        NEMOCLAW_SANDBOX_NAME: args.sandboxName,
      }),
      redactionValues: [args.apiKey],
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

async function runOpenClawAgentAssertion(
  host: HostCliClient,
  sandbox: SandboxClient,
  artifacts: ArtifactSink,
  args: {
    apiKey: string;
    expected: string;
    label: string;
    prompt: string;
    sandboxName: string;
  },
): Promise<void> {
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
  for (let attempt = 1; attempt <= OPENCLAW_AGENT_ATTEMPTS; attempt += 1) {
    const sessionId = `e2e-common-egress-${Date.now()}-${process.pid}-${attempt}`;
    const sessionRoot = "/sandbox/.openclaw/agents/main/sessions";
    const remoteCommand = [
      `rm -f ${shellQuote(`${sessionRoot}/${sessionId}.jsonl.lock`)} ${shellQuote(
        `${sessionRoot}/${sessionId}.trajectory.jsonl`,
      )} 2>/dev/null || true`,
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
        `openshell-${args.sandboxName}`,
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
    if (isOpenClawPolicyBlock(combined)) {
      throw new Error(`${args.label}: agent hit policy block: ${combined.slice(0, 600)}`);
    }

    const reply = parseOpenClawAgentText(agent.stdout);
    if (agent.exitCode === 0 && reply.includes(args.expected)) {
      return;
    }
    lastFailure = `reply='${reply.slice(0, 240)}' exit=${agent.exitCode} stdout='${agent.stdout.slice(
      0,
      240,
    )}' stderr='${agent.stderr.slice(0, 240)}'`;

    if (attempt < OPENCLAW_AGENT_ATTEMPTS && isOpenClawScopeUpgradePending(combined)) {
      await host.command("node", [CLI_ENTRYPOINT, args.sandboxName, "recover"], {
        artifactName: `${args.label}-recover-after-attempt-${attempt}`,
        env: commandEnv(),
        timeoutMs: 120_000,
      });
      await sleep(attempt * 15_000);
      continue;
    }

    if (attempt < OPENCLAW_AGENT_ATTEMPTS && isOpenClawTransientAgentError(combined)) {
      await sleep(attempt * 15_000);
      continue;
    }

    if (attempt < OPENCLAW_AGENT_ATTEMPTS) await sleep(5_000);
  }

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
  for (let attempt = 1; attempt <= HERMES_AGENT_ATTEMPTS; attempt += 1) {
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
    if (agent.exitCode === 0 && httpStatus === "200" && reply.includes(args.expected)) {
      return;
    }
    lastFailure = `exit=${agent.exitCode} http=${httpStatus} reply='${reply.slice(
      0,
      240,
    )}' body='${body.slice(0, 240)}'`;
    if (attempt < HERMES_AGENT_ATTEMPTS) await sleep(5_000);
  }

  throw new Error(`${args.label}: expected ${args.expected}, got ${lastFailure}`);
}

const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;
const openClawTest =
  process.env.NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW === "1" ? test.skip : liveTest;
const hermesTest = process.env.NEMOCLAW_COMMON_EGRESS_SKIP_HERMES === "1" ? test.skip : liveTest;

test("common-egress agent OpenClaw JSON parser accepts framed agent payloads", () => {
  expect(
    parseOpenClawAgentText(
      JSON.stringify({ payloads: [{ text: "noise" }, { text: "WEATHER_AGENT_OK" }] }),
    ),
  ).toContain("WEATHER_AGENT_OK");
  expect(
    parseOpenClawAgentText(
      JSON.stringify({ result: { payloads: [{ text: "REFERENCE_AGENT_OK" }] } }),
    ),
  ).toContain("REFERENCE_AGENT_OK");
  expect(
    parseOpenClawAgentText(
      `openclaw log line\n${JSON.stringify({
        result: { payloads: [{ text: "HERMES_REFERENCE_AGENT_OK" }] },
      })}\n`,
    ),
  ).toContain("HERMES_REFERENCE_AGENT_OK");
});

test("common-egress agent Hermes response parser reads message content", () => {
  expect(
    parseChatContent(
      JSON.stringify({ choices: [{ message: { content: "HERMES_REFERENCE_AGENT_OK" } }] }),
    ),
  ).toBe("HERMES_REFERENCE_AGENT_OK");
});

test("common-egress agent classifies pre-contract provider validation skips", () => {
  expect(
    classifyPreContractProviderValidationSkip({
      stdout: "",
      stderr:
        "NVIDIA Endpoints endpoint validation failed.\nChat Completions API validation returned HTTP 429",
    }),
  ).toMatchObject({
    http429ProviderValidationFailure: true,
    matches: true,
  });

  const originalGithubActions = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = "true";
    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr:
          "NVIDIA Endpoints endpoint validation failed.\nValidation details were omitted to avoid exposing credentials.",
      }),
    ).toMatchObject({
      matches: true,
      sanitizedEndpointValidationFailure: true,
    });
  } finally {
    if (originalGithubActions === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalGithubActions;
    }
  }

  expect(
    classifyPreContractProviderValidationSkip({
      stdout: "",
      stderr: "NVIDIA Endpoints endpoint validation failed.\ninvalid NVIDIA_API_KEY credential",
    }),
  ).toMatchObject({ matches: false });
});

describe.sequential("common-egress agent live scenarios", () => {
  openClawTest(
    "C1 OpenClaw balanced includes weather and agent fetches Open-Meteo",
    { timeout: TEST_TIMEOUT_MS },
    async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
      const apiKey = await assertPrerequisites(host, secrets, skip);
      await artifacts.writeJson("scenario.json", {
        id: "common-egress-agent",
        case: "openclaw-balanced-weather",
        migratedFrom: "test/e2e/test-common-egress-agent-e2e.sh",
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        contract: [
          "OpenClaw balanced onboarding applies weather common-egress endpoints",
          "balanced scope does not include the broader restcountries public-reference endpoint",
          "a real OpenClaw agent turn fetches Open-Meteo through web_fetch",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, OPENCLAW_BALANCED_SANDBOX);
      await runOnboard(host, {
        agent: "openclaw",
        apiKey,
        artifacts,
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        skip,
        tier: "balanced",
      });
      await assertPolicyContains(sandbox, OPENCLAW_BALANCED_SANDBOX, "c1-policy", [
        "api.open-meteo.com",
        "geocoding-api.open-meteo.com",
      ]);
      await assertPolicyAbsent(
        sandbox,
        OPENCLAW_BALANCED_SANDBOX,
        "c1-balanced-scope",
        "restcountries.com",
      );
      await runOpenClawAgentAssertion(host, sandbox, artifacts, {
        apiKey,
        expected: "WEATHER_AGENT_OK",
        label: "c1-agent-weather",
        sandboxName: OPENCLAW_BALANCED_SANDBOX,
        prompt: `Use the web_fetch tool to fetch exactly this URL:
https://api.open-meteo.com/v1/forecast?latitude=47.4979&longitude=19.0402&current=temperature_2m
After web_fetch returns, reply exactly WEATHER_AGENT_OK if the fetched response contains temperature_2m. Do not fetch any other URL.`,
      });
      await artifacts.writeJson("scenario-result.json", {
        id: "common-egress-agent",
        case: "openclaw-balanced-weather",
        status: "passed",
      });
    },
  );

  openClawTest(
    "C2 OpenClaw open includes public reference and agent fetches Wikidata",
    { timeout: TEST_TIMEOUT_MS },
    async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
      const apiKey = await assertPrerequisites(host, secrets, skip);
      await artifacts.writeJson("scenario.json", {
        id: "common-egress-agent",
        case: "openclaw-open-public-reference",
        migratedFrom: "test/e2e/test-common-egress-agent-e2e.sh",
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        contract: [
          "OpenClaw open onboarding applies public-reference common-egress endpoints",
          "a real OpenClaw agent turn fetches Wikidata through web_fetch",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, OPENCLAW_OPEN_SANDBOX);
      await runOnboard(host, {
        agent: "openclaw",
        apiKey,
        artifacts,
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        skip,
        tier: "open",
      });
      await assertPolicyContains(sandbox, OPENCLAW_OPEN_SANDBOX, "c2-policy", [
        "www.wikidata.org",
        "nominatim.openstreetmap.org",
        "query.wikidata.org",
      ]);
      await runOpenClawAgentAssertion(host, sandbox, artifacts, {
        apiKey,
        expected: "REFERENCE_AGENT_OK",
        label: "c2-agent-reference",
        sandboxName: OPENCLAW_OPEN_SANDBOX,
        prompt: `Use the web_fetch tool to fetch exactly this URL:
https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json
After web_fetch returns, reply exactly REFERENCE_AGENT_OK if the fetched response says entity Q30 has the English label United States. Do not fetch any other URL.`,
      });
      await artifacts.writeJson("scenario-result.json", {
        id: "common-egress-agent",
        case: "openclaw-open-public-reference",
        status: "passed",
      });
    },
  );

  hermesTest(
    "C3 Hermes open includes public reference plus Nous presets and agent fetches Wikidata",
    { timeout: TEST_TIMEOUT_MS },
    async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
      const apiKey = await assertPrerequisites(host, secrets, skip);
      await artifacts.writeJson("scenario.json", {
        id: "common-egress-agent",
        case: "hermes-open-public-reference",
        migratedFrom: "test/e2e/test-common-egress-agent-e2e.sh",
        sandboxName: HERMES_SANDBOX,
        contract: [
          "Hermes open onboarding applies public-reference common-egress endpoints",
          "Hermes open onboarding applies all Hermes Nous managed-tool policy presets",
          "the Hermes API-server agent path fetches Wikidata through its terminal tool",
        ],
      });
      await registerSandboxCleanup(cleanup, artifacts, host, sandbox, HERMES_SANDBOX);
      await runOnboard(host, {
        agent: "hermes",
        apiKey,
        artifacts,
        sandboxName: HERMES_SANDBOX,
        skip,
        tier: "open",
      });
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
      await runHermesAgentAssertion(sandbox, {
        expected: "HERMES_REFERENCE_AGENT_OK",
        label: "c3-agent-reference",
        prompt: buildHermesReferencePrompt(),
        sandboxName: HERMES_SANDBOX,
      });
      await artifacts.writeJson("scenario-result.json", {
        id: "common-egress-agent",
        case: "hermes-open-public-reference",
        status: "passed",
      });
    },
  );
});
