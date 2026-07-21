// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `whatsapp.statusHealth` — a `phase: "status"` hook that probes the live
 * WhatsApp bridge state from inside the sandbox and emits a
 * `messaging-channel-health` status output. Run by the generic channels-status
 * command via the status-hook runner, so no whatsapp-specific code lives in
 * the generic status orchestrator.
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
} from "./status-health-eval";

export const WHATSAPP_STATUS_HEALTH_HOOK_HANDLER_ID = "whatsapp.statusHealth";

// Bound how long we are willing to block inside an `openshell sandbox exec`
// for the diagnostic. WhatsApp's in-process bridge can go unresponsive when
// the Noise WebSocket is stuck; a fast hard cap keeps channels status from
// inheriting that hang.
const DEFAULT_TIMEOUT_MS = 8_000;
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
    // This hook consumes an OpenClaw-specific status contract. The manifest
    // gates it to OpenClaw; keep the handler fail-safe when invoked directly
    // so another agent never receives an unsupported health verdict.
    if (agent !== "openclaw") return {};
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const probe = runOpenclawStatusProbe(execute, sandboxName, timeoutMs);

    const input: WhatsappProbeInput = {
      agent,
      paired: probe.paired,
      heartbeat: probe.heartbeat,
      heartbeatParseError: null,
      bridgeProcessAlive: probe.bridgeProcessAlive,
      recentLogSignals: probe.recentLogSignals,
      probeReachable: probe.probeReachable,
      probedAt: normalizeString(context.inputs?.probedAt) ?? "",
      presetInRegistry: Boolean(context.inputs?.presetInRegistry),
      presetOnGateway: normalizeTristate(context.inputs?.presetOnGateway),
      channelEnabledInRegistry: Boolean(context.inputs?.channelEnabledInRegistry),
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
 * OpenClaw 2026.6.10 exposes live per-account state under
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
