// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserves the host-side CLI contract for `nemoclaw <name> sessions`
 * and `nemoclaw <name> agents`: real Docker/OpenShell onboarding, live NVIDIA
 * credential gating, OpenClaw pairing/scope approval draining, JSON envelope
 * parsing, and cleanup. OpenClaw still owns the in-sandbox session-store
 * recovery semantics; this test stays at NemoClaw's argv translation,
 * gateway dispatch, and JSON-envelope boundary.
 */

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { parseJsonFromText } from "./json-envelope.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-sessions-agents-cli";
const TEST_AGENT_ID = process.env.NEMOCLAW_E2E_AGENT_ID ?? "work";
const ONBOARD_TIMEOUT_MS = 40 * 60_000;
const AGENT_TURN_TIMEOUT_MS = 5 * 60_000;
const GATEWAY_RPC_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60 * 60_000;
const SCOPE_RETRY_ATTEMPTS = 5;
const SCOPE_RETRY_DELAY_MS = 4_000;
const SCOPE_PENDING_PATTERN =
  /scope upgrade pending|Failed to reach the OpenClaw gateway|pairing required/i;

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;
validateSandboxName(SANDBOX_NAME);

type JsonRecord = Record<string, unknown>;
type CommandOptions = {
  artifactName: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  redactionValues?: string[];
};

type HostedInferenceConfig = ReturnType<typeof requireHostedInferenceConfig>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    NODE_NO_WARNINGS: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_AGENT: "openclaw",
    NEMOCLAW_POLICY_TIER: "open",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    PATH: [path.join(process.env.HOME ?? "", ".local", "bin"), base.PATH].filter(Boolean).join(":"),
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup is best effort so an early setup failure keeps the original error.
  }
}

async function runNemoclaw(
  host: HostCliClient,
  args: string[],
  hosted: HostedInferenceConfig,
  options: CommandOptions,
): Promise<ShellProbeResult> {
  return await host.command("node", [CLI_ENTRYPOINT, ...args], {
    artifactName: options.artifactName,
    env: commandEnv({
      ...hosted.env,
      ...(options.env ?? {}),
    }),
    redactionValues: [hosted.apiKey, ...(options.redactionValues ?? [])],
    timeoutMs: options.timeoutMs ?? GATEWAY_RPC_TIMEOUT_MS,
  });
}

async function ensureOpenshellAvailable(host: HostCliClient): Promise<void> {
  const current = await host.command(
    "bash",
    ["-lc", "command -v openshell && openshell --version"],
    {
      artifactName: "prereq-openshell-version",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  if (current.exitCode === 0) return;

  const install = await host.command(
    "bash",
    [path.join(REPO_ROOT, "scripts", "install-openshell.sh")],
    {
      artifactName: "prereq-install-openshell",
      cwd: REPO_ROOT,
      env: commandEnv(),
      timeoutMs: 10 * 60_000,
    },
  );
  expect(install.exitCode, `install-openshell.sh failed\n${resultText(install)}`).toBe(0);

  const afterInstall = await host.command(
    "bash",
    ["-lc", "command -v openshell && openshell --version"],
    {
      artifactName: "prereq-openshell-version-after-install",
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(
    afterInstall.exitCode,
    `openshell missing after install\n${resultText(afterInstall)}`,
  ).toBe(0);
}

async function cleanupSandbox(host: HostCliClient, hosted: HostedInferenceConfig): Promise<void> {
  if (process.env.NEMOCLAW_E2E_KEEP_SANDBOX === "1") return;

  const destroy = await runNemoclaw(host, [SANDBOX_NAME, "destroy", "--yes"], hosted, {
    artifactName: "cleanup-nemoclaw-destroy-sessions-agents-cli",
    timeoutMs: 5 * 60_000,
  });
  expect(
    destroy.exitCode === 0 || isMissingSandboxCleanupOutput(resultText(destroy)),
    `cleanup NemoClaw destroy failed\n${resultText(destroy)}`,
  ).toBe(true);

  const openshellDelete = await host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
    artifactName: "cleanup-openshell-sandbox-delete-sessions-agents-cli",
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(
    openshellDelete.exitCode === 0 || isMissingSandboxCleanupOutput(resultText(openshellDelete)),
    `cleanup OpenShell sandbox delete failed\n${resultText(openshellDelete)}`,
  ).toBe(true);
}

function isMissingSandboxCleanupOutput(text: string): boolean {
  return /does not exist|not found|Run 'nemoclaw onboard'|no such sandbox/i.test(text);
}

function isPreContractEndpointValidationRateLimit(result: ShellProbeResult): boolean {
  const text = resultText(result);
  return (
    /NVIDIA Endpoints endpoint validation failed|endpoint validation failed/i.test(text) &&
    /HTTP 429|\b429\b|rate[- ]?limit|quota|temporarily unavailable|Validation details were omitted to avoid exposing credentials/i.test(
      text,
    )
  );
}

function tailEvidence(text: string, maxLength = 2_000): string {
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function parseJsonEnvelope(result: ShellProbeResult, label: string): unknown {
  const candidates = [result.stdout, resultText(result)].filter((candidate) => candidate.trim());
  for (const candidate of candidates) {
    try {
      const parsed = parseJsonFromText(candidate);
      expect(
        typeof parsed === "object" && parsed !== null,
        `${label} JSON envelope must be an object or array`,
      ).toBe(true);
      return parsed;
    } catch {
      // Try the next candidate. stdout is preferred because stderr can carry
      // process warnings after an otherwise valid JSON payload.
    }
  }
  throw new Error(`${label} did not contain parseable JSON:\n${resultText(result)}`);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function sessionEntries(envelope: unknown): JsonRecord[] {
  if (Array.isArray(envelope))
    return envelope.filter((entry): entry is JsonRecord => !!asRecord(entry));
  const sessions = asRecord(envelope)?.sessions;
  return Array.isArray(sessions)
    ? sessions.filter((entry): entry is JsonRecord => !!asRecord(entry))
    : [];
}

function agentEntries(envelope: unknown): JsonRecord[] {
  if (Array.isArray(envelope))
    return envelope.filter((entry): entry is JsonRecord => !!asRecord(entry));
  const agents = asRecord(envelope)?.agents;
  return Array.isArray(agents)
    ? agents.filter((entry): entry is JsonRecord => !!asRecord(entry))
    : [];
}

function firstSessionKey(envelope: unknown): string | undefined {
  for (const entry of sessionEntries(envelope)) {
    if (typeof entry.key === "string" && entry.key.length > 0) return entry.key;
  }
  return undefined;
}

function pendingRequestIds(envelope: unknown): string[] {
  const pending = asRecord(envelope)?.pending;
  if (!Array.isArray(pending)) return [];
  return pending
    .map((entry) => asRecord(entry)?.requestId ?? asRecord(entry)?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function approvePendingPairingRequests(
  host: HostCliClient,
  hosted: HostedInferenceConfig,
  artifactPrefix: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const state = await runNemoclaw(
      host,
      [SANDBOX_NAME, "exec", "--", "openclaw", "devices", "list", "--json"],
      hosted,
      {
        artifactName: `${artifactPrefix}-devices-list-${attempt}`,
        timeoutMs: 60_000,
      },
    );
    if (state.exitCode !== 0 || !state.stdout.trim()) {
      await sleep(3_000);
      continue;
    }

    let ids: string[] = [];
    try {
      ids = pendingRequestIds(parseJsonEnvelope(state, "openclaw devices list --json"));
    } catch {
      await sleep(3_000);
      continue;
    }
    if (ids.length === 0) return true;

    for (const id of ids) {
      await runNemoclaw(
        host,
        [SANDBOX_NAME, "exec", "--", "openclaw", "devices", "approve", id, "--json"],
        hosted,
        {
          artifactName: `${artifactPrefix}-devices-approve-${id}`,
          timeoutMs: 60_000,
        },
      );
    }
    await sleep(3_000);
  }
  return false;
}

async function runGatewayRpcWithScopeRetry(
  host: HostCliClient,
  args: string[],
  hosted: HostedInferenceConfig,
  artifactName: string,
): Promise<ShellProbeResult> {
  let lastResult: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= SCOPE_RETRY_ATTEMPTS; attempt += 1) {
    lastResult = await runNemoclaw(host, args, hosted, {
      artifactName: `${artifactName}-attempt-${attempt}`,
      timeoutMs: GATEWAY_RPC_TIMEOUT_MS,
    });
    if (lastResult.exitCode === 0) return lastResult;
    if (!SCOPE_PENDING_PATTERN.test(resultText(lastResult))) break;
    await approvePendingPairingRequests(host, hosted, `${artifactName}-scope-${attempt}`);
    await sleep(SCOPE_RETRY_DELAY_MS);
  }
  return lastResult!;
}

async function expectJsonCommand(
  host: HostCliClient,
  args: string[],
  hosted: HostedInferenceConfig,
  artifactName: string,
): Promise<unknown> {
  const result = await runNemoclaw(host, args, hosted, { artifactName });
  expect(result.exitCode, `${args.join(" ")} failed\n${resultText(result)}`).toBe(0);
  return parseJsonEnvelope(result, args.join(" "));
}

test("sessions/agents host CLI routes to OpenClaw and preserves JSON envelopes", {
  timeout: TEST_TIMEOUT_MS,
}, async ({ artifacts, cleanup, host, secrets, skip }) => {
  expect(fs.existsSync(CLI_ENTRYPOINT), "bin/nemoclaw.js missing").toBe(true);
  expect(
    fs.existsSync(CLI_DIST_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  await artifacts.target.declare({
    id: "sessions-agents-cli",
    boundary: "host-cli-openclaw-sessions-agents-gateway",
    sandboxName: SANDBOX_NAME,
    contracts: [
      "NVIDIA_INFERENCE_API_KEY absence skips the live credential-gated target",
      "nemoclaw <name> sessions --json defaults to OpenClaw sessions list",
      "nemoclaw <name> sessions list --json returns a parseable JSON envelope",
      "sessions reset/delete gateway RPCs retry through pending pairing/scope approval",
      "nemoclaw <name> agents add/list/delete pass through to the in-sandbox OpenClaw CLI",
      "the secondary agent session key is removed through sessions delete --json",
      "cleanup destroys the named sandbox unless NEMOCLAW_E2E_KEEP_SANDBOX=1",
    ],
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-sessions-agents-cli",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, `Docker is required for sessions/agents E2E\n${resultText(docker)}`).toBe(
    0,
  );

  const hosted = requireHostedInferenceConfig(secrets);
  await ensureOpenshellAvailable(host);
  cleanup.add(`destroy sessions/agents sandbox ${SANDBOX_NAME}`, async () =>
    bestEffort(() => cleanupSandbox(host, hosted)),
  );
  await cleanupSandbox(host, hosted);
  fs.rmSync(path.join(process.env.HOME ?? "", ".nemoclaw", "onboard.lock"), { force: true });

  const onboard = await runNemoclaw(
    host,
    ["onboard", "--non-interactive", "--yes-i-accept-third-party-software"],
    hosted,
    {
      artifactName: "onboard-sessions-agents-cli",
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  if (onboard.exitCode !== 0 && isPreContractEndpointValidationRateLimit(onboard)) {
    await artifacts.writeJson("onboard-endpoint-validation-skip.json", {
      reason:
        "NVIDIA endpoint validation was externally rate-limited or sanitized before the sessions/agents CLI contract could run.",
      exitCode: onboard.exitCode,
      stdoutTail: tailEvidence(onboard.stdout),
      stderrTail: tailEvidence(onboard.stderr),
    });
    skip(
      "NVIDIA endpoint validation hit HTTP 429/sanitized failure before sessions/agents CLI contract could run",
    );
  }
  expect(onboard.exitCode, `onboard failed\n${resultText(onboard)}`).toBe(0);

  await approvePendingPairingRequests(host, hosted, "post-onboard-scope");

  const mainSeed = await runNemoclaw(
    host,
    [SANDBOX_NAME, "exec", "--", "openclaw", "agent", "--agent", "main", "-m", "ping"],
    hosted,
    {
      artifactName: "seed-main-session",
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
    },
  );

  if (mainSeed.exitCode === 0) {
    await approvePendingPairingRequests(host, hosted, "post-main-seed-scope");
    await expectJsonCommand(
      host,
      [SANDBOX_NAME, "sessions", "--json"],
      hosted,
      "tc-sess-01-sessions-default-json",
    );
    await expectJsonCommand(
      host,
      [SANDBOX_NAME, "sessions", "list", "--json"],
      hosted,
      "tc-sess-02-sessions-list-json",
    );

    const reset = await runGatewayRpcWithScopeRetry(
      host,
      [SANDBOX_NAME, "sessions", "reset", "agent:main:main", "--json"],
      hosted,
      "tc-sess-03-sessions-reset-main-json",
    );
    expect(reset.exitCode, `sessions reset failed\n${resultText(reset)}`).toBe(0);
    const resetEnvelope = parseJsonEnvelope(reset, "sessions reset --json");
    expect(asRecord(resetEnvelope)?.key, "sessions reset JSON must include key").toBe(
      "agent:main:main",
    );

    await expectJsonCommand(
      host,
      [SANDBOX_NAME, "sessions", "list", "--json"],
      hosted,
      "tc-sess-04-sessions-list-after-reset-json",
    );
  } else {
    await artifacts.writeJson("main-session-cases-skipped.json", {
      reason: "main agent seed failed; preserving legacy TC-SESS-01..04 skip behavior",
      exitCode: mainSeed.exitCode,
      stderr: mainSeed.stderr,
    });
  }

  const addAgent = await runNemoclaw(
    host,
    [
      SANDBOX_NAME,
      "agents",
      "add",
      TEST_AGENT_ID,
      "--workspace",
      `/sandbox/.openclaw/workspace-${TEST_AGENT_ID}`,
      "--non-interactive",
    ],
    hosted,
    {
      artifactName: "tc-agent-01-agents-add-passthrough",
      timeoutMs: 120_000,
    },
  );
  expect(addAgent.exitCode, `agents add failed\n${resultText(addAgent)}`).toBe(0);

  await expectJsonCommand(
    host,
    [SANDBOX_NAME, "sessions", "list", "--agent", TEST_AGENT_ID, "--json"],
    hosted,
    "tc-agent-01-sessions-list-agent-after-add-json",
  );

  const agentsList = await expectJsonCommand(
    host,
    [SANDBOX_NAME, "agents", "list", "--json"],
    hosted,
    "tc-agent-03-agents-list-json",
  );
  expect(
    agentEntries(agentsList).some((entry) => entry.id === TEST_AGENT_ID),
    `agents list --json must include '${TEST_AGENT_ID}'`,
  ).toBe(true);

  const workSeed = await runNemoclaw(
    host,
    [SANDBOX_NAME, "exec", "--", "openclaw", "agent", "--agent", TEST_AGENT_ID, "-m", "ping"],
    hosted,
    {
      artifactName: "seed-work-agent-session",
      timeoutMs: AGENT_TURN_TIMEOUT_MS,
    },
  );
  expect(workSeed.exitCode, `work-agent seed failed\n${resultText(workSeed)}`).toBe(0);

  await approvePendingPairingRequests(host, hosted, "post-work-seed-scope");
  const workSessions = await expectJsonCommand(
    host,
    [SANDBOX_NAME, "sessions", "list", "--agent", TEST_AGENT_ID, "--json"],
    hosted,
    "tc-sess-05-work-agent-sessions-json",
  );
  const sessionKey = firstSessionKey(workSessions);
  expect(
    sessionKey,
    `expected a session key for agent '${TEST_AGENT_ID}' after seed prompt`,
  ).toBeTruthy();

  const deleteSession = await runGatewayRpcWithScopeRetry(
    host,
    [SANDBOX_NAME, "sessions", "delete", sessionKey!, "--json"],
    hosted,
    "tc-sess-05-sessions-delete-json",
  );
  expect(deleteSession.exitCode, `sessions delete failed\n${resultText(deleteSession)}`).toBe(0);
  const deleteEnvelope = parseJsonEnvelope(deleteSession, "sessions delete --json");
  expect(asRecord(deleteEnvelope)?.key, "sessions delete JSON must include deleted key").toBe(
    sessionKey,
  );

  const workSessionsAfterDelete = await expectJsonCommand(
    host,
    [SANDBOX_NAME, "sessions", "list", "--agent", TEST_AGENT_ID, "--json"],
    hosted,
    "tc-sess-05-work-agent-sessions-after-delete-json",
  );
  expect(
    sessionEntries(workSessionsAfterDelete).some((entry) => entry.key === sessionKey),
    `session key '${sessionKey}' must be absent after delete`,
  ).toBe(false);

  const deleteAgent = await runNemoclaw(
    host,
    [SANDBOX_NAME, "agents", "delete", TEST_AGENT_ID, "--force", "--json"],
    hosted,
    {
      artifactName: "tc-agent-02-agents-delete-json",
      timeoutMs: 120_000,
    },
  );
  expect(deleteAgent.exitCode, `agents delete failed\n${resultText(deleteAgent)}`).toBe(0);

  const agentsAfterDelete = await expectJsonCommand(
    host,
    [SANDBOX_NAME, "agents", "list", "--json"],
    hosted,
    "tc-agent-02-agents-list-after-delete-json",
  );
  expect(
    agentEntries(agentsAfterDelete).some((entry) => entry.id === TEST_AGENT_ID),
    `agent '${TEST_AGENT_ID}' still visible after delete`,
  ).toBe(false);
});
