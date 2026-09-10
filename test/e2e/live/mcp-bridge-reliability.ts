// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildHermesMcpStatusCommand,
  OPENCLAW_MCPORTER_ROOT,
} from "../../../src/lib/actions/sandbox/mcp-bridge-adapter-status";
import { buildMcpCredentialRevisionObservationCommand } from "../../../src/lib/actions/sandbox/mcp-bridge-provider";
import type { McpAttachedCredentialRevision } from "../../../src/lib/actions/sandbox/mcp-bridge-provider-readiness";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import type { McpBridgeEntry } from "../../../src/lib/state/registry";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { runBoundedRetry, type RetryEvidence } from "../../../tools/e2e/retry-evidence.mts";
import {
  buildHermesMcpChatProbeScript,
  HERMES_MCP_FAILURE_CAPTURE_BYTES,
  type HermesMcpCommandResult,
  isHermesGatewayDrainingResponse,
} from "./mcp-bridge-hermes-http.ts";
import { MCP_PROVIDER_REWRITE_PROBE_SOURCE } from "./mcp-provider-rewrite-probe.ts";
import { FAKE_MCP_STATUS_RESULT_TOKEN } from "./mcp-bridge-servers.ts";

const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;
const HERMES_GATEWAY_DRAINING_RETRIES = 3;
const HERMES_GATEWAY_DRAINING_RETRY_DELAY_MS = 5_000;
const HERMES_MCP_STATUS_RETRY_DELAY_MS = 5_000;
export const MCP_BRIDGE_TEST_REDACTION_VALUES = Object.values(MCP_BRIDGE_TEST_CREDENTIALS);
export const MCP_BRIDGE_DENIED_TOOL_NAME = "fake_status";
export const MCP_BRIDGE_DENIED_TOOL_SELECTOR = "fake_s*";
export const HERMES_MCP_ENV_LOAD_COMMANDS = [
  "set -a",
  "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
  "set +a",
] as const;
const MCP_BRIDGE_DENIED_TOOL_PROMPT =
  "Run the managed denied-tool policy probe and return its result verbatim.";
const MCP_BRIDGE_DENIED_TOOL_RESULT = "policy_denied";
const MCP_DENIAL_AUDIT_RE =
  /\bJSONRPC_L7_REQUEST decision=deny rule_methods=tools\/call tools=fake_status\b[^\r\n]*\breason=[^\r\n]*deny rule/iu;
const MCP_DENIAL_AUDIT_ATTEMPTS = 5;
const MCP_DENIAL_AUDIT_RETRY_MS = 250;

export const HERMES_MCP_DENIED_TOOL_PROBE = {
  mode: "bridge" as const,
  promptMarker: MCP_BRIDGE_DENIED_TOOL_PROMPT,
  resultToken: MCP_BRIDGE_DENIED_TOOL_RESULT,
  toolName: `mcp__fake__${MCP_BRIDGE_DENIED_TOOL_NAME}`,
};
export const DEEPAGENTS_MCP_DENIED_TOOL_PROBE = {
  mode: "progressive" as const,
  promptMarker: MCP_BRIDGE_DENIED_TOOL_PROMPT,
  query: MCP_BRIDGE_DENIED_TOOL_NAME,
  resultToken: MCP_BRIDGE_DENIED_TOOL_RESULT,
  toolName: `fake_${MCP_BRIDGE_DENIED_TOOL_NAME}`,
};

export async function runDeniedMcpToolCall(host: HostCliClient, options: {
  agent: "openclaw" | "hermes" | "langchain-deepagents-code";
  artifactName: string;
  deniedTool?: string;
  sandbox: SandboxClient;
  sandboxName: string;
  serverName: string;
  requests: ReadonlyArray<{ rpcMethod?: string }>;
}): Promise<{ after: number; before: number; policyDenied: boolean; result: ShellProbeResult }> {
  const countToolCalls = () =>
    options.requests.filter((request) => request.rpcMethod === "tools/call").length;
  const readDenialAuditEvents = async (artifactName: string): Promise<string[] | null> => {
    const logs = await host.command(
      host.openshellCommandPath,
      ["logs", options.sandboxName, "-n", "500", "--source", "all", "--since", "2m"],
      {
        artifactName,
        env: buildAvailabilityProbeEnv(),
        redactionValues: MCP_BRIDGE_TEST_REDACTION_VALUES,
        timeoutMs: 30_000,
      },
    );
    if (logs.timedOut || logs.exitCode !== 0) return null;
    return resultText(logs)
      .split(/\r?\n/u)
      .filter((line) => MCP_DENIAL_AUDIT_RE.test(line));
  };
  const audit = await host.command(
    host.openshellCommandPath,
    ["settings", "set", options.sandboxName, "--key", "ocsf_json_enabled", "--value", "true"],
    {
      artifactName: `${options.artifactName}-enable-audit`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  const denialAuditBefore =
    !audit.timedOut && audit.exitCode === 0
      ? await readDenialAuditEvents(`${options.artifactName}-audit-before`)
      : null;
  const priorDenialAuditEvents = new Set(denialAuditBefore ?? []);
  const before = countToolCalls();
  const payload = JSON.stringify({
    model: "mock/mcp-bridge",
    messages: [{ role: "user", content: MCP_BRIDGE_DENIED_TOOL_PROMPT }],
    max_tokens: 256,
  });
  const redactionValues = [
    ...MCP_BRIDGE_TEST_REDACTION_VALUES,
    MCP_BRIDGE_DENIED_TOOL_PROMPT,
    payload,
  ];
  const command =
    options.agent === "openclaw"
      ? `nemoclaw-start mcporter --root ${shellQuote(OPENCLAW_MCPORTER_ROOT)} call ${options.serverName}.${options.deniedTool ?? MCP_BRIDGE_DENIED_TOOL_NAME} --args '{}' --output json`
      : options.agent === "hermes"
        ? [
            ...HERMES_MCP_ENV_LOAD_COMMANDS,
            buildHermesMcpChatProbeScript(payload, MCP_BRIDGE_DENIED_TOOL_RESULT),
          ].join("\n")
        : `nemoclaw-start dcode -n ${JSON.stringify(MCP_BRIDGE_DENIED_TOOL_PROMPT)}`;
  const run = (artifactName: string) =>
    options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(["set -eu", command].join("\n")),
      {
        artifactName,
        captureLimitBytes:
          options.agent === "hermes" ? HERMES_MCP_FAILURE_CAPTURE_BYTES : undefined,
        env: buildAvailabilityProbeEnv(),
        redactionValues: options.agent === "hermes" ? redactionValues : [],
        timeoutMs: options.agent === "openclaw" ? 90_000 : 5 * 60_000,
      },
    );
  const result = await run(options.artifactName);
  let policyDenied = false;
  for (
    let attempt = 1;
    denialAuditBefore !== null && attempt <= MCP_DENIAL_AUDIT_ATTEMPTS;
    attempt += 1
  ) {
    const denialAuditAfter = await readDenialAuditEvents(
      `${options.artifactName}-audit-after-${String(attempt)}`,
    );
    policyDenied =
      denialAuditAfter?.some((event) => !priorDenialAuditEvents.has(event)) ?? false;
    if (policyDenied) break;
    if (attempt < MCP_DENIAL_AUDIT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, MCP_DENIAL_AUDIT_RETRY_MS));
    }
  }
  return {
    after: countToolCalls(),
    before,
    policyDenied,
    result,
  };
}

export async function runOpenClawDeniedToolUpdateProof(
  host: HostCliClient,
  sandbox: SandboxClient,
  requests: Array<{ auth: string; rpcMethod?: string; rpcToolName?: string }>,
  sandboxName: string,
): Promise<{
  after: number;
  before: number;
  clear: ShellProbeResult;
  commandsSucceeded: boolean;
  call: ShellProbeResult;
  lastCall: { auth: string; rpcMethod?: string; rpcToolName?: string } | undefined;
  replace: ShellProbeResult;
}> {
  const commandOptions = (artifactName: string) => ({
    artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 90_000,
  });
  const clear = await host.nemoclaw(
    [sandboxName, "mcp", "update", "fake", "--clear-deny-tools"],
    commandOptions("openclaw-clear-denied-tools"),
  );
  const before = requests.filter((request) => request.rpcMethod === "tools/call").length;
  const call = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      `nemoclaw-start mcporter --root ${shellQuote(OPENCLAW_MCPORTER_ROOT)} call fake.${MCP_BRIDGE_DENIED_TOOL_NAME} --args '{}' --output json`,
    ),
    commandOptions("openclaw-formerly-denied-tool-call"),
  );
  const calls = requests.filter((request) => request.rpcMethod === "tools/call");
  const replace = await host.nemoclaw(
    [sandboxName, "mcp", "update", "fake", "--deny-tool", MCP_BRIDGE_DENIED_TOOL_SELECTOR],
    commandOptions("openclaw-restore-denied-tool"),
  );
  const denied = await runDeniedMcpToolCall(host, {
    agent: "openclaw",
    artifactName: "openclaw-restored-denied-tool-call",
    deniedTool: MCP_BRIDGE_DENIED_TOOL_NAME,
    requests,
    sandbox,
    sandboxName,
    serverName: "fake",
  });
  const commandsSucceeded =
    [clear, call, replace].every((result) => !result.timedOut && result.exitCode === 0) &&
    resultText(call).includes(FAKE_MCP_STATUS_RESULT_TOKEN) &&
    calls.at(-1)?.rpcMethod === "tools/call" &&
    calls.at(-1)?.rpcToolName === MCP_BRIDGE_DENIED_TOOL_NAME &&
    !denied.result.timedOut &&
    denied.result.exitCode !== null &&
    denied.policyDenied &&
    /policy_denied|blocked by deny rule/iu.test(resultText(denied.result)) &&
    denied.after === denied.before;
  return {
    after: calls.length,
    before,
    call,
    clear,
    commandsSucceeded,
    lastCall: calls.at(-1),
    replace,
  };
}

export async function runMcpProviderRewriteProbe(
  sandbox: SandboxClient,
  sandboxName: string,
  targetUrl: string,
  method: string,
  expectation: "allow" | "deny" | "deny-strict",
  artifactName: string,
  credentialKey = "FAKE_MCP_SECRET",
): Promise<ShellProbeResult> {
  return sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        `nemoclaw-start node - ${shellQuote(targetUrl)} ${shellQuote(method)} ${shellQuote(expectation)} ${shellQuote(credentialKey)} <<'NEMOCLAW_MCP_PROVIDER_REWRITE_PROBE'`,
        MCP_PROVIDER_REWRITE_PROBE_SOURCE,
        "NEMOCLAW_MCP_PROVIDER_REWRITE_PROBE",
      ].join("\n"),
    ),
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 90_000 },
  );
}
const OPENCLAW_BASELINE_SCOPE_CAUSE =
  "its canonical CLI device did not receive the required baseline scopes";
const HERMES_RESTART_TRANSPORT_FAILURE_SUFFIX = [
  `Error: x code: 'Unknown error', message: "h2 protocol error: error reading a body`,
  `| from connection", source: hyper::Error(Body, Error { kind: Io(Custom`,
  `| { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })`,
  `|-> error reading a body from connection`,
  `|-> stream closed because of a broken pipe`,
].join("\n");
const HERMES_RESTART_SUCCESS_PREFIX = new RegExp(
  `^${[
    String.raw`Effective egress that would be opened:`,
    String.raw`(?:.*\n)*?\s*- (?<host>[a-z0-9-]+\.trycloudflare\.com):\d+[^\n]*`,
    String.raw`(?:.*\n)*?Applied preset: mcp-bridge-concurrent`,
    String.raw`Narrowing sandbox egress — removing: \k<host>`,
    String.raw`Removed preset: mcp-bridge-concurrent`,
    String.raw`✓ Policy version (?<cleanupVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
    String.raw`✓ Policy version \k<cleanupVersion> loaded \(active version: \k<cleanupVersion>\)`,
    String.raw`✓ Policy version (?<commitVersion>\d+) submitted \(hash: [0-9a-f]+\)`,
    String.raw`✓ Policy version \k<commitVersion> loaded \(active version: \k<commitVersion>\)`,
  ].join("\n")}$`,
  "u",
);

function normalizeHermesTransportDiagnostic(diagnostic: string): string {
  return diagnostic
    .replace(ANSI_ESCAPE, "")
    .replaceAll("\u00d7", "x")
    .replaceAll("\u2502", "|")
    .replaceAll("\u251c\u2500\u25b6", "|->")
    .replaceAll("\u2570\u2500\u25b6", "|->")
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .join("\n");
}

interface McpStatusCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const HERMES_MCP_POST_ADD_NOT_READY = `code: 'The system is not in a state required for the operation's | execution', message: "sandbox is not ready"`;

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Match the successful add result that reports OpenShell's post-reload not-ready state.
 * Remove this classifier when a committed Hermes add waits for its replacement sandbox to
 * expose the current credential revision before it returns (#9485).
 */
export function isHermesMcpAddPostProbeNotReady(
  adapter: string,
  result: McpStatusCommandResult,
): boolean {
  if (
    adapter !== "hermes-config" ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut
  ) {
    return false;
  }
  const diagnostic = normalizeHermesTransportDiagnostic(
    `${result.stdout}\n${result.stderr}`,
  ).replace(/\s+/gu, " ");
  return (
    diagnostic.includes(" probe was inconclusive: Error: x ") &&
    diagnostic.includes(HERMES_MCP_POST_ADD_NOT_READY)
  );
}

/** Match only the structured status gap observed while a managed Hermes reload settles. */
export function isHermesMcpStatusAwaitingRestartSettlement(
  adapter: string,
  server: string,
  result: McpStatusCommandResult,
): boolean {
  if (
    adapter !== "hermes-config" ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.stderr.trim() !== ""
  ) {
    return false;
  }

  let status: Record<string, unknown> | null = null;
  try {
    status = objectValue(JSON.parse(result.stdout) as unknown);
  } catch {
    return false;
  }
  if (!status) return false;

  const support = objectValue(status.support);
  const env = objectValue(status.env);
  const provider = objectValue(status.provider);
  const credentialResolution = objectValue(provider?.credentialResolution);
  const policy = objectValue(status.policy);
  const adapterStatus = objectValue(status.adapter);
  const warnings = status.warnings;
  return (
    status.server === server &&
    status.agent === "hermes" &&
    Array.isArray(warnings) &&
    warnings.length === 0 &&
    support?.supported === true &&
    support.mode === "bridge" &&
    support?.adapter === "hermes-config" &&
    Array.isArray(env?.names) &&
    env.names.length === 1 &&
    typeof env.names[0] === "string" &&
    Array.isArray(env.missing) &&
    env.missing.length === 0 &&
    env?.ready === true &&
    typeof provider?.name === "string" &&
    provider.name !== "" &&
    provider?.registryPresent === true &&
    provider.gatewayPresent === true &&
    provider.attached === true &&
    provider.credentialReady === true &&
    credentialResolution?.ok === null &&
    credentialResolution.detail ===
      "probe skipped: the current OpenShell credential revision could not be observed" &&
    policy?.registryPresent === true &&
    typeof policy.name === "string" &&
    policy.name !== "" &&
    policy.gatewayPresent === true &&
    adapterStatus?.registered === null &&
    adapterStatus.detail ===
      "Adapter inspection was skipped because the current OpenShell credential revision could not be observed."
  );
}

function statusAdapterRegistration(result: McpStatusCommandResult): boolean | null {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) return null;
  try {
    const status = objectValue(JSON.parse(result.stdout) as unknown);
    const adapter = objectValue(status?.adapter);
    return typeof adapter?.registered === "boolean" ? adapter.registered : null;
  } catch {
    return null;
  }
}

type HermesRegistrationObservation =
  | { source: "cached-status"; result: McpStatusCommandResult }
  | { source: "direct-credential"; result: McpStatusCommandResult }
  | { source: "direct-adapter"; result: McpStatusCommandResult };

/**
 * Retry one read-only adapter observation after the exact managed-reload readiness gap.
 * Attempt one consumes the already-captured status result. It must not invoke `mcp status`
 * again because that command can recover gateway state. Attempt two reads and validates the
 * credential revision. It inspects Hermes config only when the revision and bridge entry are valid.
 */
export async function confirmHermesMcpRegistrationAfterRestartSettlement(options: {
  adapter: string;
  server: string;
  committedAddResult: McpStatusCommandResult;
  initialStatusResult: McpStatusCommandResult;
  observeCurrentRegistration: () => Promise<
    Exclude<HermesRegistrationObservation, { source: "cached-status" }>
  >;
  sleep?: (milliseconds: number) => Promise<void>;
  onEvidence?: (evidence: RetryEvidence) => Promise<void> | void;
}): Promise<{ registered: boolean; evidence: RetryEvidence }> {
  const execution = await runBoundedRetry<HermesRegistrationObservation>({
    operation: "mcp-bridge.hermes-registration-observation",
    owner: "mcp-bridge",
    idempotence: "read-only",
    maxAttempts: 2,
    delayMs: HERMES_MCP_STATUS_RETRY_DELAY_MS,
    run: async (attempt) =>
      attempt === 1
        ? { source: "cached-status", result: options.initialStatusResult }
        : options.observeCurrentRegistration(),
    classify: (value, error) => {
      if (error !== undefined || value === undefined) {
        return { outcome: "failed", failureClass: "deterministic" } as const;
      }
      if (value.source === "cached-status") {
        if (
          isHermesMcpAddPostProbeNotReady(options.adapter, options.committedAddResult) &&
          isHermesMcpStatusAwaitingRestartSettlement(options.adapter, options.server, value.result)
        ) {
          return { outcome: "failed", failureClass: "transient-external" } as const;
        }
        return statusAdapterRegistration(value.result) === true
          ? ({ outcome: "passed" } as const)
          : ({ outcome: "failed", failureClass: "deterministic" } as const);
      }
      if (value.source !== "direct-adapter") {
        return { outcome: "failed", failureClass: "deterministic" } as const;
      }
      const registered =
        value.result.exitCode === 0 &&
        value.result.signal === null &&
        !value.result.timedOut &&
        value.result.stderr.trim() === "" &&
        value.result.stdout.trim() === "registered";
      return registered
        ? ({ outcome: "passed" } as const)
        : ({ outcome: "failed", failureClass: "deterministic" } as const);
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.onEvidence ? { onEvidence: options.onEvidence } : {}),
  });
  return { registered: execution.outcome === "passed", evidence: execution.evidence };
}

function hermesEntryFromStatus(
  result: McpStatusCommandResult,
  expected: { server: string; url: string; credentialEnvName: string },
): McpBridgeEntry | null {
  try {
    const status = objectValue(JSON.parse(result.stdout) as unknown);
    const provider = objectValue(status?.provider);
    const policy = objectValue(status?.policy);
    if (
      status?.server !== expected.server ||
      status.agent !== "hermes" ||
      status.url !== expected.url ||
      typeof provider?.name !== "string" ||
      provider.name === "" ||
      typeof policy?.name !== "string" ||
      policy.name === "" ||
      typeof status.addedAt !== "string" ||
      status.addedAt === ""
    ) {
      return null;
    }
    return {
      server: expected.server,
      agent: "hermes",
      adapter: "hermes-config",
      url: expected.url,
      env: [expected.credentialEnvName],
      providerName: provider.name,
      policyName: policy.name,
      addedAt: status.addedAt,
    };
  } catch {
    return null;
  }
}

/** Read concurrent status once, then confirm only an unknown Hermes registration directly. */
export async function readConcurrentMcpStatusAndConfirmHermesRegistration(options: {
  clients: {
    artifacts: Pick<ArtifactSink, "writeJson">;
    host: Pick<HostCliClient, "nemoclaw">;
    sandbox: Pick<SandboxClient, "execShell">;
  };
  committedAddResult: McpStatusCommandResult;
  credentialEnvName: string;
  env: Record<string, string>;
  redactionValues: string[];
  scenario: {
    artifactPrefix: string;
    expectedAdapter: string;
    mcpUrl: string;
    sandboxName: string;
  };
  server: string;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{ result: McpStatusCommandResult; registered: boolean }> {
  const result = await options.clients.host.nemoclaw(
    [options.scenario.sandboxName, "mcp", "status", options.server, "--json"],
    {
      artifactName: `${options.scenario.artifactPrefix}-mcp-concurrent-add-coherent-status`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 60_000,
    },
  );
  if (options.scenario.expectedAdapter !== "hermes-config") {
    return { result, registered: statusAdapterRegistration(result) === true };
  }

  const confirmation = await confirmHermesMcpRegistrationAfterRestartSettlement({
    adapter: options.scenario.expectedAdapter,
    server: options.server,
    committedAddResult: options.committedAddResult,
    initialStatusResult: result,
    observeCurrentRegistration: async () => {
      const revision = await options.clients.sandbox.execShell(
        options.scenario.sandboxName,
        trustedSandboxShellScript(
          buildMcpCredentialRevisionObservationCommand(options.credentialEnvName),
        ),
        {
          artifactName: `${options.scenario.artifactPrefix}-mcp-concurrent-status-restart-settlement-credential-revision`,
          env: buildAvailabilityProbeEnv(),
          redactionValues: options.redactionValues,
          timeoutMs: 60_000,
        },
      );
      const observedRevision = revision.stdout.trim();
      const entry = hermesEntryFromStatus(result, {
        server: options.server,
        url: options.scenario.mcpUrl,
        credentialEnvName: options.credentialEnvName,
      });
      if (
        revision.exitCode !== 0 ||
        revision.signal !== null ||
        revision.timedOut ||
        revision.stderr.trim() !== "" ||
        !/^v[0-9]{1,20}$/u.test(observedRevision) ||
        entry === null
      ) {
        return { source: "direct-credential", result: revision } as const;
      }
      return {
        source: "direct-adapter",
        result: await options.clients.sandbox.execShell(
          options.scenario.sandboxName,
          trustedSandboxShellScript(
            buildHermesMcpStatusCommand(entry, observedRevision as McpAttachedCredentialRevision),
          ),
          {
            artifactName: `${options.scenario.artifactPrefix}-mcp-concurrent-status-restart-settlement-adapter-registration`,
            env: buildAvailabilityProbeEnv(),
            redactionValues: options.redactionValues,
            timeoutMs: 60_000,
          },
        ),
      } as const;
    },
    onEvidence: async (evidence) => {
      await options.clients.artifacts.writeJson(
        "retry/hermes-mcp-concurrent-registration-restart-settlement.json",
        evidence,
      );
    },
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return { result, registered: confirmation.registered };
}

export function isRetryableOpenClawBaselineScopeOnboardFailure(
  agent: string,
  sandboxName: string,
  result: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
): boolean {
  if (
    agent !== "openclaw" ||
    result.exitCode === null ||
    result.exitCode === 0 ||
    result.signal !== null ||
    result.timedOut
  ) {
    return false;
  }
  const expected = `OpenClaw onboarding for '${sandboxName}' is incomplete because ${OPENCLAW_BASELINE_SCOPE_CAUSE}. Resume or rerun onboarding.`;
  return `${result.stdout}\n${result.stderr}`
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/u)
    .some((line) => line.trim() === expected);
}

export async function retryOpenClawBaselineScopeOnboardFailure<
  T extends {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
>(options: {
  agent: string;
  sandboxName: string;
  initialResult: T;
  retry: () => Promise<T>;
}): Promise<T> {
  return isRetryableOpenClawBaselineScopeOnboardFailure(
    options.agent,
    options.sandboxName,
    options.initialResult,
  )
    ? options.retry()
    : options.initialResult;
}

export function isHermesRestartTransportFailure(adapter: string, diagnostic: string): boolean {
  // The producer is OpenShell's sandbox-exec HTTP/2 stream while the packaged
  // Hermes transaction helper performs its acknowledged SIGUSR1 gateway reload.
  // NemoClaw cannot repair that transport from this E2E boundary. The live
  // caller first proves one coherent committed bridge, then retries only the
  // serialized loser and still requires the canonical duplicate rejection.
  // Remove this classifier when OpenShell preserves command completion across
  // that managed reload or returns a structured post-commit outcome (#6692).
  if (adapter !== "hermes-config") return false;
  const normalized = normalizeHermesTransportDiagnostic(diagnostic);
  const suffix = `\n${HERMES_RESTART_TRANSPORT_FAILURE_SUFFIX}`;
  if (!normalized.endsWith(suffix)) return false;

  return HERMES_RESTART_SUCCESS_PREFIX.test(normalized.slice(0, -suffix.length));
}

export async function retryAfterHermesRestartTransportFailure<T>(options: {
  adapter: string;
  committedBridgeVerified: boolean;
  diagnostic: string;
  originalResult: T;
  retry: () => Promise<T>;
}): Promise<T> {
  if (!options.committedBridgeVerified) {
    throw new Error("Hermes restart retry requires a verified committed bridge");
  }
  if (/already exists/iu.test(options.diagnostic)) return options.originalResult;
  if (!isHermesRestartTransportFailure(options.adapter, options.diagnostic)) {
    throw new Error("rejected concurrent add was not a known Hermes restart transport failure");
  }
  return options.retry();
}

export async function retryHermesGatewayDraining<T extends HermesMcpCommandResult>(options: {
  initialResult: T;
  retry: (attempt: number) => Promise<T>;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let result = options.initialResult;
  for (
    let attempt = 1;
    attempt <= HERMES_GATEWAY_DRAINING_RETRIES && isHermesGatewayDrainingResponse(result);
    attempt += 1
  ) {
    await wait(HERMES_GATEWAY_DRAINING_RETRY_DELAY_MS);
    result = await options.retry(attempt);
  }
  return result;
}

export async function restartBridgeWithoutHostSecret(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const restart = await host.nemoclaw([sandboxName, "mcp", "restart", "fake"], {
    artifactName: `${artifactPrefix}-mcp-restart-provider-reuse`,
    env: buildAvailabilityProbeEnv(),
    redactionValues: MCP_BRIDGE_TEST_REDACTION_VALUES,
    timeoutMs: 12 * 60_000,
  });
  assertExitZero(restart, `${artifactPrefix} mcp restart without host secret`);
}
