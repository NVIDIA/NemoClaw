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
import {
  type HostedInferenceConfig,
  requireHostedInferenceConfig,
} from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  agentReplyContainsToken,
  classifyPreContractProviderValidationSkip,
  parseChatContent,
  parseOpenClawAgentText,
} from "./common-egress-agent-helpers.ts";
import { stripAnsi } from "./json-envelope.ts";

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

interface CleanupAttempt {
  exitCode: number | null;
  missingSandboxTolerated: boolean;
  outputTail: string;
}

interface ActivePolicyPreset {
  name: string;
  provenance: string;
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
    artifacts: ArtifactSink;
    hosted: HostedInferenceConfig;
    sandboxName: string;
    skip: SkipFn;
    tier: "balanced" | "open";
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
    if (agent.exitCode === 0 && agentReplyContainsToken(reply, args.expected)) {
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
    if (
      agent.exitCode === 0 &&
      httpStatus === "200" &&
      agentReplyContainsToken(reply, args.expected)
    ) {
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

const liveTest = shouldRunLiveE2E() ? test : test.skip;
const openClawTest =
  process.env.NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW === "1" ? test.skip : liveTest;
const hermesTest = process.env.NEMOCLAW_COMMON_EGRESS_SKIP_HERMES === "1" ? test.skip : liveTest;

describe.sequential("common-egress agent live targets", () => {
  openClawTest(
    "C1 OpenClaw balanced excludes weather until explicitly added, then permits a verified wttr.in curl",
    { timeout: TEST_TIMEOUT_MS },
    async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
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
    { timeout: TEST_TIMEOUT_MS },
    async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
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
      await runOnboard(host, {
        agent: "openclaw",
        artifacts,
        hosted,
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
      await artifacts.target.complete({
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
      await runOnboard(host, {
        agent: "hermes",
        artifacts,
        hosted,
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
      await artifacts.target.complete({
        id: "common-egress-agent",
        case: "hermes-open-public-reference",
        status: "passed",
      });
    },
  );
});
