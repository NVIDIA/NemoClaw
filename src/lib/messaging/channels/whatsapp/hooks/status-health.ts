// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `whatsapp.statusHealth` — a `phase: "status"` hook that probes the live
 * WhatsApp bridge state from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no whatsapp-specific code lives in
 * the generic status orchestrator.
 *
 * For Hermes, the probe reads only fixed boolean evidence about the two known
 * WhatsApp session paths:
 *
 *   /sandbox/.hermes/platforms/whatsapp/session/creds.json
 *   /sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session/creds.json
 *
 * It never reads credential file contents or lists session directories.
 *
 * The documented repair for a dashboard-only session points
 * `platforms.whatsapp.extra.session_path` at another directory, so the default
 * gateway path stays empty while the gateway reads credentials elsewhere. When
 * the default path holds no credentials, a sandbox-local parser reads that
 * key and returns only its JSON value. The host never receives the complete
 * Hermes config. The probe then re-checks the configured directory so the
 * repair can be confirmed instead of reported as an unresolved split.
 *
 * This is a bounded compatibility probe for Hermes dashboard pairing that can
 * write credentials under profiles/dashboard-home while the gateway reads the
 * default session path. Remove the dashboard profile branch after Hermes uses
 * one shared WhatsApp session path for both dashboard pairing and gateway
 * startup.
 *
 * The probe reads OpenClaw's authoritative live status JSON:
 *
 *   openclaw channels status --channel whatsapp --json --timeout <ms>
 *
 * That JSON already reflects the live `linked`/`running`/`connected` /
 * `healthState` state kept by the in-process bridge, so the probe never
 * needs to scrape gateway-log breadcrumbs, list a credentials directory,
 * or grep for a bridge process — all three signals were misleading in
 * different real cases:
 *
 *   - Append-only `starting provider` breadcrumbs in `/tmp/gateway.log`
 *     survive across restarts, so a stopped bridge would still read
 *     "provider ready" (false-positive healthy).
 *   - A non-empty `credentials/whatsapp` dir does not imply a valid paired
 *     session — half-written state or credentials from a prior tenant
 *     read as "populated" without actually pairing.
 *   - The bridge runs inside the OpenClaw gateway process, so `pgrep`
 *     could not enumerate it and the probe would report "unpaired" for
 *     a working bridge.
 *
 * Redaction contract: this probe never reads, stores, logs, or emits the
 * self.e164 / self.jid / self.lid values or the raw `lastError` string
 * from the OpenClaw JSON — those can carry phone numbers. Only booleans,
 * state-string enums, and epoch timestamps make it into the report.
 */

import { shellQuote } from "../../../../core/shell-quote";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  type ChannelStatusHealthHookOptions,
  MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
} from "../../channel-health";
import {
  evaluateWhatsappDiagnostics,
  type WhatsappHeartbeat,
  type WhatsappProbeInput,
  type WhatsappSessionLocations,
} from "./status-health-eval";

export const WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID = "whatsapp.statusHealth";

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the diagnostic. WhatsApp's in-process bridge can go unresponsive when
// the Noise WebSocket is stuck; a fast hard cap keeps channels status from
// inheriting that hang.
const DEFAULT_TIMEOUT_MS = 8_000;
const HERMES_SESSION_PROBE_SENTINEL = "NEMOCLAW_HERMES_WHATSAPP_SESSION_V1";
const HERMES_CONFIG_PROBE_SENTINEL = "NEMOCLAW_HERMES_WHATSAPP_CONFIG_V1";
const HERMES_CONFIG_PATH = "/sandbox/.hermes/config.yaml";
const HERMES_DEFAULT_SESSION_DIR = "/sandbox/.hermes/platforms/whatsapp/session";
const HERMES_DASHBOARD_SESSION_DIR =
  "/sandbox/.hermes/profiles/dashboard-home/platforms/whatsapp/session";
const HERMES_SESSION_PATH_KEYS = ["platforms", "whatsapp", "extra", "session_path"] as const;
const HERMES_SESSION_DIR_PATTERN = /^\/sandbox\/\.hermes\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** WhatsApp uses the generic channel-health hook options unchanged. */
export type WhatsappStatusHealthHookOptions = ChannelStatusHealthHookOptions;

export function createWhatsappStatusHealthHook(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookHandler {
  return (context) => {
    if (context.channelId !== "whatsapp") return {};
    const execute = options.executeSandboxCommand;
    const sandboxName = normalizeString(context.inputs?.currentSandbox);
    // Without a sandbox target or an exec runner there is nothing to probe
    // (e.g. the top-level status runner does not thread an exec runner into
    // this hook).
    if (!execute || !sandboxName) return {};

    const agent = normalizeString(context.inputs?.agent) ?? "openclaw";
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const probe =
      agent === "openclaw"
        ? runOpenclawStatusProbe(execute, sandboxName, timeoutMs)
        : agent === "hermes"
          ? runHermesSessionProbe(execute, sandboxName, timeoutMs)
          : null;
    if (!probe) return {};

    const input: WhatsappProbeInput = {
      agent,
      paired: probe.paired,
      heartbeat: probe.heartbeat,
      heartbeatParseError: null,
      bridgeProcessAlive: probe.bridgeProcessAlive,
      recentLogSignals: probe.recentLogSignals,
      probeReachable: probe.probeReachable,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      presetApplied: Boolean(context.inputs?.presetApplied),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
      ...(probe.sessionLocations ? { sessionLocations: probe.sessionLocations } : {}),
    };
    const report = evaluateWhatsappDiagnostics(input);
    return {
      outputs: {
        channelHealth: {
          kind: "status",
          value: {
            type: MESSAGING_CHANNEL_HEALTH_OUTPUT_TYPE,
            report,
          } as unknown as MessagingSerializableValue,
        },
      },
    };
  };
}

export function createWhatsappStatusHealthHookRegistration(
  options: WhatsappStatusHealthHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID,
    handler: createWhatsappStatusHealthHook(options),
  };
}

type OpenclawWhatsappState = {
  readonly configured?: unknown;
  readonly statusState?: unknown;
  readonly linked?: unknown;
  readonly running?: unknown;
  readonly connected?: unknown;
  readonly healthState?: unknown;
  readonly lastInboundAt?: unknown;
  readonly lastStopAt?: unknown;
  readonly lastDisconnect?: unknown;
  readonly reconnectAttempts?: unknown;
};

type ValidatedOpenclawWhatsappState = OpenclawWhatsappState & {
  readonly linked: boolean;
  readonly running: boolean;
  readonly connected: boolean;
};

type ProbeResult = {
  readonly probeReachable: boolean;
  readonly paired: boolean | null;
  readonly bridgeProcessAlive: boolean | null;
  readonly heartbeat: WhatsappHeartbeat | null;
  readonly recentLogSignals: readonly string[];
  readonly sessionLocations?: WhatsappSessionLocations;
};

const PROBE_UNREACHABLE: ProbeResult = {
  probeReachable: false,
  paired: null,
  bridgeProcessAlive: null,
  heartbeat: null,
  recentLogSignals: [],
};

/**
 * OpenClaw branch. Runs `openclaw channels status --channel whatsapp --json`
 * inside the sandbox and translates the authoritative response into the
 * evaluator's probe-input shape. The CLI shells out to the gateway, which
 * reflects the in-process bridge's current state, so this replaces the old
 * log-scraping + pgrep + dir-listing signals with a single trusted source.
 */
function runOpenclawStatusProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): ProbeResult {
  const command = `openclaw channels status --channel whatsapp --json --timeout ${timeoutMs}`;
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(sandboxName, command, timeoutMs);
  } catch {
    return PROBE_UNREACHABLE;
  }
  // A non-zero exec (timeout/kill/unhealthy sandbox) can still carry partial
  // stdout; require a clean exit before trusting the probe. Otherwise a
  // stalled openclaw invocation could yield unparseable JSON that reads as a
  // fabricated verdict instead of classifying as probe_failed.
  if (!exec || exec.status !== 0) return PROBE_UNREACHABLE;
  const json = parseOpenclawJson(String(exec.stdout ?? ""));
  if (!json) return PROBE_UNREACHABLE;
  const channelAccounts = readObject(json.channelAccounts);
  // Successful OpenClaw responses expose live channel/account maps and omit
  // `gatewayReachable`; only the CLI's config-only failure response sets that
  // field to false. Honor an explicit reachability bit when present, while
  // accepting the canonical successful shape only when a live map exists.
  if (!isReachableGatewayStatusPayload(json, channelAccounts)) {
    return PROBE_UNREACHABLE;
  }
  const waLookup = readWhatsappState(json, channelAccounts);
  if (waLookup.kind === "invalid") return PROBE_UNREACHABLE;
  const wa = waLookup.kind === "found" ? waLookup.state : null;

  if (!wa) {
    // No authoritative WhatsApp account. The exact legacy unknown-channel
    // error means WhatsApp is not configured; otherwise the reachable gateway
    // simply did not include live WhatsApp status. Leave runtime fields null so
    // the evaluator lands on an honest "unknown" verdict in either case.
    return {
      probeReachable: true,
      paired: null,
      bridgeProcessAlive: null,
      heartbeat: null,
      recentLogSignals: [describeMissingWaChannel(json)],
    };
  }
  if (!hasRequiredWhatsappLiveness(wa)) return PROBE_UNREACHABLE;
  return mapOpenclawWaState(wa);
}

function runHermesSessionProbe(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): ProbeResult {
  const configuredProbeTimeoutMs = Math.floor(timeoutMs / 4);
  const configProbeTimeoutMs = Math.floor(timeoutMs / 4);
  const defaultProbeTimeoutMs = timeoutMs - configProbeTimeoutMs - configuredProbeTimeoutMs;
  const defaultLocations = probeHermesSessionDirs(
    execute,
    sandboxName,
    HERMES_DEFAULT_SESSION_DIR,
    defaultProbeTimeoutMs,
  );
  if (!defaultLocations) return PROBE_UNREACHABLE;
  if (defaultLocations.gatewaySessionCreds !== false) {
    return hermesProbeResult(defaultLocations, "default");
  }

  // The default-path check, config read, and configured-path check share one
  // caller-supplied timeout budget. For sub-millisecond fallback budgets, keep
  // the successful default result instead of starting an unbounded extra probe.
  if (configProbeTimeoutMs < 1 || configuredProbeTimeoutMs < 1) {
    return hermesProbeResult(defaultLocations, "default");
  }
  const configured = readHermesConfiguredSessionDir(execute, sandboxName, configProbeTimeoutMs);
  if (configured.source !== "config") {
    return hermesProbeResult(defaultLocations, configured.source);
  }
  const configuredLocations = probeHermesSessionDirs(
    execute,
    sandboxName,
    configured.dir,
    configuredProbeTimeoutMs,
  );
  if (!configuredLocations) return hermesProbeResult(defaultLocations, "default");
  return hermesProbeResult(configuredLocations, "config", configured.dir);
}

function hermesProbeResult(
  locations: WhatsappSessionLocations,
  gatewaySessionPathSource: HermesSessionPathSource,
  gatewaySessionDir?: string,
): ProbeResult {
  const gatewaySession = locations.gatewaySessionCreds === true;
  return {
    probeReachable: true,
    paired: gatewaySession ? null : false,
    bridgeProcessAlive: null,
    heartbeat: null,
    recentLogSignals: [],
    sessionLocations: {
      ...locations,
      gatewaySessionPathSource,
      ...(gatewaySessionDir === undefined ? {} : { gatewaySessionDir }),
    },
  };
}

function probeHermesSessionDirs(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  gatewaySessionDir: string,
  timeoutMs: number,
): WhatsappSessionLocations | null {
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(sandboxName, hermesSessionProbeCommand(gatewaySessionDir), timeoutMs);
  } catch {
    return null;
  }
  if (!exec || exec.status !== 0) return null;
  return parseHermesSessionProbe(String(exec.stdout ?? ""));
}

type HermesSessionPathSource = NonNullable<WhatsappSessionLocations["gatewaySessionPathSource"]>;

function readHermesConfiguredSessionDir(
  execute: NonNullable<WhatsappStatusHealthHookOptions["executeSandboxCommand"]>,
  sandboxName: string,
  timeoutMs: number,
): { readonly dir: string; readonly source: HermesSessionPathSource } {
  const fallback = { dir: HERMES_DEFAULT_SESSION_DIR, source: "default" } as const;
  let exec: ReturnType<typeof execute>;
  try {
    exec = execute(sandboxName, hermesConfiguredSessionPathCommand(), timeoutMs);
  } catch {
    return fallback;
  }
  if (!exec || exec.status !== 0) return fallback;
  const configured = parseHermesConfiguredSessionPath(String(exec.stdout ?? ""));
  if (configured === undefined || configured === null) return fallback;
  if (!isSupportedHermesSessionDir(configured)) {
    return { dir: HERMES_DEFAULT_SESSION_DIR, source: "unsupported" };
  }
  if (configured === HERMES_DEFAULT_SESSION_DIR) return fallback;
  return { dir: configured, source: "config" };
}

function hermesConfiguredSessionPathCommand(): string {
  const script = [
    "import json",
    "from pathlib import Path",
    "import yaml",
    `config = yaml.safe_load(Path(${JSON.stringify(HERMES_CONFIG_PATH)}).read_text(encoding=\"utf-8\"))`,
    "def child(value, key):",
    "    return value.get(key) if isinstance(value, dict) else None",
    "node = config",
    ...HERMES_SESSION_PATH_KEYS.map((key) => `node = child(node, ${JSON.stringify(key)})`),
    `print(${JSON.stringify(HERMES_CONFIG_PROBE_SENTINEL)})`,
    "print(json.dumps(node))",
  ].join("\n");
  return `python3 -c ${shellQuote(script)}`;
}

function parseHermesConfiguredSessionPath(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 2 || lines[0] !== HERMES_CONFIG_PROBE_SENTINEL) return undefined;
  try {
    return JSON.parse(lines[1]);
  } catch {
    return undefined;
  }
}

function isSupportedHermesSessionDir(value: unknown): value is string {
  if (typeof value !== "string" || !HERMES_SESSION_DIR_PATTERN.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function hermesSessionProbeCommand(gatewaySessionDir: string): string {
  return [
    `gateway=${shellQuote(`${gatewaySessionDir}/creds.json`)}`,
    `dashboard=${shellQuote(`${HERMES_DASHBOARD_SESSION_DIR}/creds.json`)}`,
    `printf '%s\\n' '${HERMES_SESSION_PROBE_SENTINEL}'`,
    'if [ -f "$gateway" ]; then printf "%s\\n" "GATEWAY_SESSION=present"; else printf "%s\\n" "GATEWAY_SESSION=missing"; fi',
    'if [ -f "$dashboard" ]; then printf "%s\\n" "DASHBOARD_SESSION=present"; else printf "%s\\n" "DASHBOARD_SESSION=missing"; fi',
  ].join("; ");
}

function parseHermesSessionProbe(stdout: string): WhatsappSessionLocations | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.includes(HERMES_SESSION_PROBE_SENTINEL)) return null;
  const gateway = readProbeBoolean(lines, "GATEWAY_SESSION");
  const dashboard = readProbeBoolean(lines, "DASHBOARD_SESSION");
  if (gateway === null || dashboard === null) return null;
  return { gatewaySessionCreds: gateway, dashboardSessionCreds: dashboard };
}

function readProbeBoolean(lines: readonly string[], key: string): boolean | null {
  const match = lines.find((line) => line === `${key}=present` || line === `${key}=missing`);
  if (match === `${key}=present`) return true;
  if (match === `${key}=missing`) return false;
  return null;
}

function hasRequiredWhatsappLiveness(
  wa: OpenclawWhatsappState,
): wa is ValidatedOpenclawWhatsappState {
  return (
    typeof wa.linked === "boolean" &&
    typeof wa.running === "boolean" &&
    typeof wa.connected === "boolean"
  );
}

function mapOpenclawWaState(wa: ValidatedOpenclawWhatsappState): ProbeResult {
  const { linked, running, connected } = wa;
  const healthState = readStringValue(wa.healthState);
  const heartbeat: WhatsappHeartbeat | null = running
    ? {
        connectionState: openclawConnectionState(connected, healthState),
        lastInboundAt: epochMsToIso(wa.lastInboundAt),
        // The OpenClaw JSON does not expose a cumulative inbound counter —
        // the evaluator treats `null` here as "not reported" rather than
        // "zero", which is the accurate reading.
        messagesHandled: null,
        // Never copy the bridge's free-text `lastError` — it can carry phone
        // numbers and message bodies. If the evaluator needs error signal it
        // reads healthState/connectionState instead.
        noteCategory: null,
      }
    : null;
  return {
    probeReachable: true,
    // linked is the authoritative pairing bit; the credentials-directory
    // check that used to sit here mistook half-written state as pairing.
    paired: linked,
    // running is the authoritative liveness bit; the pgrep check that used
    // to sit here could not see the in-process bridge, and the gateway-log
    // breadcrumbs are append-only so they survived a stopped bridge.
    bridgeProcessAlive: running,
    heartbeat,
    recentLogSignals: summarizeOpenclawLive(healthState, wa.reconnectAttempts),
  };
}

function openclawConnectionState(connected: boolean, healthState: string | null): string {
  if (connected) return "open";
  return healthState === "starting" || healthState === "stale" ? "connecting" : "close";
}

// The documented healthState enum. `readStringValue` would otherwise pass
// arbitrary external text through, so any non-enum value is mapped to a fixed
// "unknown" token before it can reach diagnostics (redaction contract).
const KNOWN_HEALTH_STATES: ReadonlySet<string> = new Set([
  "starting",
  "healthy",
  "stale",
  "stopped",
]);

// Never emit raw error text or self.* PII. Only the healthState enum and
// reconnectAttempts (a non-negative integer) are surfaced, and only when they
// carry non-healthy signal.
function summarizeOpenclawLive(
  healthState: string | null,
  reconnectAttemptsRaw: unknown,
): readonly string[] {
  const parts: string[] = [];
  if (healthState !== null && healthState !== "healthy") {
    parts.push(`healthState=${KNOWN_HEALTH_STATES.has(healthState) ? healthState : "unknown"}`);
  }
  const reconnectAttempts =
    typeof reconnectAttemptsRaw === "number" && Number.isFinite(reconnectAttemptsRaw)
      ? reconnectAttemptsRaw
      : null;
  if (reconnectAttempts !== null && reconnectAttempts > 0) {
    parts.push(`reconnectAttempts=${reconnectAttempts}`);
  }
  return parts.length > 0 ? [parts.join("; ")] : [];
}

function parseOpenclawJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    // `--json` is a strict machine-readable contract. Do not scan past an
    // arbitrary stdout preamble and then trust a later object as gateway
    // status; an exact documented prefix can be handled here if one exists.
    return null;
  }
}

function isReachableGatewayStatusPayload(
  json: Record<string, unknown>,
  channelAccounts: Record<string, unknown> | null,
): boolean {
  if (Object.prototype.hasOwnProperty.call(json, "gatewayReachable")) {
    return json.gatewayReachable === true;
  }
  return channelAccounts !== null;
}

type WhatsappStateLookup =
  | { readonly kind: "found"; readonly state: OpenclawWhatsappState }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" };

/**
 * OpenClaw 2026.7.1 exposes live per-account state under
 * `channelAccounts.whatsapp` and names the authoritative account through
 * `channelDefaultAccountId.whatsapp`. Select that exact account rather than
 * trusting array order or the channel-level summary. Every supported OpenClaw
 * producer, down to the blueprint compatibility floor, provides this account
 * map, so a summary-only response is an unknown contract and fails closed.
 */
function readWhatsappState(
  json: Record<string, unknown>,
  channelAccounts: Record<string, unknown> | null,
): WhatsappStateLookup {
  if (!Object.prototype.hasOwnProperty.call(json, "channelAccounts")) return { kind: "invalid" };
  if (!channelAccounts) return { kind: "invalid" };
  if (!Object.prototype.hasOwnProperty.call(channelAccounts, "whatsapp")) {
    return { kind: "missing" };
  }

  const rawAccounts = channelAccounts.whatsapp;
  if (!Array.isArray(rawAccounts)) return { kind: "invalid" };
  const accounts: Record<string, unknown>[] = [];
  for (const rawAccount of rawAccounts) {
    const account = readObject(rawAccount);
    if (!account) return { kind: "invalid" };
    accounts.push(account);
  }
  if (accounts.length === 0) return { kind: "missing" };

  const defaultAccountIds = readObject(json.channelDefaultAccountId);
  const defaultAccountId = defaultAccountIds ? readStringValue(defaultAccountIds.whatsapp) : null;
  if (!defaultAccountId) return { kind: "invalid" };
  const matches = accounts.filter(
    (account) => readStringValue(account.accountId) === defaultAccountId,
  );
  return matches.length === 1 ? { kind: "found", state: matches[0] } : { kind: "invalid" };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isObjectRecord(value) ? value : null;
}

function readStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasUnknownChannelError(json: Record<string, unknown>): boolean {
  return readStringValue(json.error) === "unknown channel: whatsapp";
}

// The CLI can report missing WhatsApp status with the exact
// `error: "unknown channel: whatsapp"` when WhatsApp is not configured. A
// canonical successful payload can also omit that channel without an error.
// Emit fixed diagnostic strings only — never the raw error, which can carry PII.
function describeMissingWaChannel(json: Record<string, unknown>): string {
  return hasUnknownChannelError(json)
    ? "whatsapp is not configured on the gateway — live health unavailable"
    : "gateway returned no live WhatsApp status";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The largest timestamp the ECMAScript Date type can represent; beyond it
// `new Date(v).toISOString()` throws RangeError. A garbage `lastInboundAt`
// from the gateway JSON must degrade to null, not crash the status command.
const MAX_ECMASCRIPT_DATE_MS = 8_640_000_000_000_000;

function epochMsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value > MAX_ECMASCRIPT_DATE_MS) return null;
  return new Date(value).toISOString();
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTristate(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MS;
}
