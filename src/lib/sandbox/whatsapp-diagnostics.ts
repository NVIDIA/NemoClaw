// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers that translate raw probe evidence collected from inside a
 * sandbox into a structured WhatsApp channel diagnostic.
 *
 * The probes themselves live in `actions/sandbox/channel-status.ts`; this
 * module never touches the filesystem, child processes, or the clock so the
 * evaluation can be exercised hermetically from fixtures. Issue #4386 reported
 * a paired-looking WhatsApp channel where the Noise WebSocket was alive but no
 * inbound events arrived, and the existing CLI surface silently rendered
 * "healthy". The diagnostic below separates QR/session state, WebSocket state,
 * inbound-event delivery, and policy/config coverage so a paired-but-idle
 * channel cannot be mistaken for working.
 */

export type DiagnosticSeverity = "ok" | "warn" | "fail" | "info";

export type DiagnosticSignal = {
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
  hint?: string;
};

export type WhatsappVerdict =
  | "healthy"
  | "idle"
  | "unpaired"
  | "policy_gap"
  | "config_gap"
  | "unknown"
  | "probe_failed";

export type WhatsappHeartbeat = {
  // ISO 8601 timestamp of the most recent inbound event observed by the
  // bridge, or null when the bridge has never reported one. We do not parse
  // message content — only timestamps and counters — to avoid pulling
  // personal data into the host diagnostic output.
  lastInboundAt: string | null;
  // Cumulative count of inbound messages handled. Optional because not every
  // bridge build emits it; absence is rendered as "not reported".
  messagesHandled: number | null;
  // Optional connection state string (e.g. "open", "connecting", "close").
  // The parser whitelists short, known token shapes only; arbitrary text
  // from bridge `state` fields is dropped to avoid leaking message bodies
  // or phone numbers into the host diagnostic output.
  connectionState: string | null;
  // Sanitized one-word category derived from any bridge `lastError`/`note`
  // field. We never copy the raw error string — bridges have been observed
  // to embed phone numbers, message snippets, and even tokens in these
  // fields. Possible values: "unauthorized", "connection-closed",
  // "rate-limited", "logged-out", "other", or null.
  noteCategory: string | null;
};

export type WhatsappProbeInput = {
  // Agent owning the sandbox: "openclaw", "hermes", etc. Used for hint text.
  agent: string;
  // State directories inspected inside the sandbox. Discovered from the agent
  // manifest in the orchestrator.
  stateDirs: readonly string[];
  // True when the bridge state directory exists inside the sandbox and is
  // non-empty. False when the directory is missing or empty. Null when the
  // probe could not run (sandbox stopped, exec failed, etc.).
  stateDirPopulated: boolean | null;
  // Parsed heartbeat — null when no heartbeat file was found or it failed
  // to parse. parseError records the reason a present file failed.
  heartbeat: WhatsappHeartbeat | null;
  heartbeatParseError: string | null;
  // True when at least one bridge process (Baileys, openclaw-whatsapp,
  // hermes whatsapp adapter) was observed running. Null on probe failure.
  bridgeProcessAlive: boolean | null;
  // Snippets of recent bridge log output that mention well-known signals
  // (connection.open, 401 unauthorized, qr expired). The diagnostic never
  // surfaces raw message bodies — only short matched lines.
  recentLogSignals: readonly string[];
  // Whether the orchestrator could run `openshell sandbox exec` at all.
  probeReachable: boolean;
  // ISO timestamp captured by the orchestrator when the probe ran. The
  // diagnostic uses it to compute "minutes since last inbound" without
  // depending on the system clock.
  probedAt: string;
  // Whether the whatsapp preset is recorded in the sandbox registry.
  presetInRegistry: boolean;
  // Whether the whatsapp preset's network policy is loaded on the gateway,
  // or null when the gateway could not be reached.
  presetOnGateway: boolean | null;
  // Whether the whatsapp channel is recorded in the registry messaging plan.
  channelEnabledInRegistry: boolean;
};

export type WhatsappDiagnosticReport = {
  schemaVersion: 1;
  channel: "whatsapp";
  agent: string;
  verdict: WhatsappVerdict;
  probedAt: string;
  signals: DiagnosticSignal[];
  heartbeat: WhatsappHeartbeat | null;
  hints: string[];
};

// Bridges flush their session blob immediately after a successful QR pair;
// treat "missing or empty state dir" as the strongest no-pair signal. An
// existing dir with no heartbeat is treated as "paired, status unknown"
// rather than "unpaired" because some builds defer the heartbeat file.
const NO_INBOUND_WARN_MINUTES = 5;

function minutesSince(iso: string | null, probedAt: string): number | null {
  if (!iso) return null;
  const last = Date.parse(iso);
  const now = Date.parse(probedAt);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return null;
  if (now < last) return 0;
  return Math.floor((now - last) / 60_000);
}

// Bridges have shipped builds that wrote free-form strings into
// `lastInboundAt`. Treat any non-date value as "no inbound observed" so
// the diagnostic neither prints the raw string nor declares healthy on
// the strength of an unparseable timestamp.
function isParseableTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}

function pairingSignal(input: WhatsappProbeInput): DiagnosticSignal {
  if (!input.probeReachable) {
    return {
      label: "Pairing / session",
      severity: "info",
      detail: "could not reach sandbox to inspect WhatsApp session state",
      hint: "start the sandbox before re-running channels status",
    };
  }
  if (input.stateDirPopulated === null) {
    return {
      label: "Pairing / session",
      severity: "info",
      detail: "session state directory probe did not complete",
    };
  }
  if (input.stateDirPopulated === false) {
    const loginHint =
      input.agent === "hermes"
        ? "run `hermes whatsapp` inside the sandbox to display a QR code"
        : "run `openclaw channels login --channel whatsapp` inside the sandbox to display a QR code";
    return {
      label: "Pairing / session",
      severity: "warn",
      detail: "no WhatsApp session state in the sandbox — never paired or session cleared",
      hint: loginHint,
    };
  }
  return {
    label: "Pairing / session",
    severity: "ok",
    detail: `paired (session state present at ${input.stateDirs.join(", ") || "agent state dir"})`,
  };
}

function websocketSignal(input: WhatsappProbeInput): DiagnosticSignal {
  if (input.heartbeatParseError) {
    return {
      label: "Noise WebSocket",
      severity: "warn",
      detail: `heartbeat file present but unparseable: ${input.heartbeatParseError}`,
      hint: "rebuild the sandbox if the heartbeat format is stale",
    };
  }
  const state = input.heartbeat?.connectionState ?? null;
  if (!state) {
    if (input.bridgeProcessAlive === false) {
      return {
        label: "Noise WebSocket",
        severity: "fail",
        detail: "no bridge process and no heartbeat — WhatsApp Web is not connected",
        hint: "check `nemoclaw <sandbox> logs --follow` for bridge startup errors",
      };
    }
    return {
      label: "Noise WebSocket",
      severity: "info",
      detail: "connection state not reported by the bridge",
    };
  }
  const normalized = state.toLowerCase();
  if (normalized === "open" || normalized === "connected") {
    return {
      label: "Noise WebSocket",
      severity: "ok",
      detail: `connection state: ${state}`,
    };
  }
  if (normalized === "connecting" || normalized === "reconnecting") {
    return {
      label: "Noise WebSocket",
      severity: "warn",
      detail: `connection state: ${state}`,
      hint: "re-run channels status in a minute; if it stays connecting, restart the bridge",
    };
  }
  return {
    label: "Noise WebSocket",
    severity: "fail",
    detail: `connection state: ${state}`,
    hint: "check `nemoclaw <sandbox> logs --follow` and re-pair if WhatsApp Web kicked the session",
  };
}

function inboundSignal(input: WhatsappProbeInput): DiagnosticSignal {
  const hb = input.heartbeat;
  if (!hb) {
    if (input.stateDirPopulated === true && input.bridgeProcessAlive !== false) {
      return {
        label: "Inbound delivery",
        severity: "warn",
        detail: "bridge has not published a heartbeat — inbound delivery is not observable",
        hint: "send a test message to the bot from a paired phone; if `lastInboundAt` stays null, the bridge is not subscribed to inbound events",
      };
    }
    return {
      label: "Inbound delivery",
      severity: "info",
      detail: "no heartbeat available",
    };
  }
  const lastInbound = isParseableTimestamp(hb.lastInboundAt) ? hb.lastInboundAt : null;
  if (lastInbound === null) {
    // A bridge that publishes the counter without a timestamp still proves
    // some inbound traffic has reached the handler — surface that as
    // information rather than as a "no inbound" warning that would gate the
    // overall verdict on a non-existent timestamp.
    if (hb.messagesHandled !== null && hb.messagesHandled > 0) {
      return {
        label: "Inbound delivery",
        severity: "info",
        detail: `lastInboundAt not reported by the bridge (messagesHandled=${hb.messagesHandled})`,
      };
    }
    return {
      label: "Inbound delivery",
      severity: "warn",
      detail:
        hb.messagesHandled !== null
          ? `paired but no inbound message observed (messagesHandled=${hb.messagesHandled})`
          : "paired but no inbound message observed (lastInboundAt is null)",
      hint: "send a test message to the bot from a paired phone, then re-run; if it stays null, restart the bridge and re-check logs",
    };
  }
  const stale = minutesSince(lastInbound, input.probedAt);
  const note = hb.messagesHandled !== null ? ` (messagesHandled=${hb.messagesHandled})` : "";
  if (stale !== null && stale > NO_INBOUND_WARN_MINUTES) {
    return {
      label: "Inbound delivery",
      severity: "info",
      detail: `last inbound ${stale}m ago at ${lastInbound}${note}`,
    };
  }
  return {
    label: "Inbound delivery",
    severity: "ok",
    detail: `last inbound at ${lastInbound}${note}`,
  };
}

function policyCoverageSignal(input: WhatsappProbeInput): DiagnosticSignal {
  if (input.presetOnGateway === false && input.presetInRegistry) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "whatsapp preset recorded locally but missing from the gateway policy",
      hint: "rebuild the sandbox so the preset is reapplied to the OpenShell gateway",
    };
  }
  if (!input.presetInRegistry) {
    // A missing local preset is a deterministic gap regardless of gateway
    // reachability — the next rebuild will not reapply WhatsApp egress and
    // the channel will eventually fail closed. Treat it as a fail so the
    // verdict short-circuits into "policy_gap" even when a stale heartbeat
    // would otherwise suggest healthy inbound delivery.
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "whatsapp preset is not applied to the sandbox",
      hint: "run `nemoclaw <sandbox> policy-add whatsapp` and rebuild the sandbox",
    };
  }
  if (input.presetOnGateway === null) {
    return {
      label: "Policy coverage",
      severity: "info",
      detail: "whatsapp preset recorded locally; gateway is unreachable for cross-check",
    };
  }
  return {
    label: "Policy coverage",
    severity: "ok",
    detail: "whatsapp preset applied and loaded on the gateway",
  };
}

function configCoverageSignal(input: WhatsappProbeInput): DiagnosticSignal {
  if (!input.channelEnabledInRegistry) {
    return {
      label: "Channel registration",
      severity: "fail",
      detail: "whatsapp is not in the sandbox messaging plan",
      hint: "run `nemoclaw <sandbox> channels add whatsapp` before pairing",
    };
  }
  return {
    label: "Channel registration",
    severity: "ok",
    detail: "whatsapp channel registered for the sandbox",
  };
}

function logSignals(input: WhatsappProbeInput): DiagnosticSignal | null {
  if (!input.recentLogSignals || input.recentLogSignals.length === 0) return null;
  return {
    label: "Recent log signals",
    severity: "info",
    detail: input.recentLogSignals.slice(0, 4).join("; "),
  };
}

function bridgeProcessSignal(input: WhatsappProbeInput): DiagnosticSignal {
  if (input.bridgeProcessAlive === null) {
    // pgrep never ran or its output never reached the parser — almost
    // always a probe timeout. Treat as info so a non-bridge probe failure
    // does not gate the verdict on this signal.
    return {
      label: "Bridge process",
      severity: "info",
      detail: "could not enumerate sandbox processes",
    };
  }
  if (input.bridgeProcessAlive === false) {
    // pgrep completed and matched neither `whatsapp`, `baileys`, nor any
    // WhatsApp state-dir path. Either the bridge crashed after leaving a
    // heartbeat behind, or it runs under a process name the pattern
    // cannot catch. Fail loud either way — a recent heartbeat on disk is
    // not, on its own, proof the bridge is still running.
    return {
      label: "Bridge process",
      severity: "fail",
      detail: "no WhatsApp bridge process observed",
      hint: "check `nemoclaw <sandbox> logs --follow` for startup errors",
    };
  }
  return {
    label: "Bridge process",
    severity: "ok",
    detail: "bridge process running",
  };
}

function pickVerdict(signals: DiagnosticSignal[], input: WhatsappProbeInput): WhatsappVerdict {
  if (!input.probeReachable) return "probe_failed";
  if (signals.some((s) => s.label === "Channel registration" && s.severity === "fail")) {
    return "config_gap";
  }
  if (signals.some((s) => s.label === "Policy coverage" && s.severity === "fail")) {
    return "policy_gap";
  }
  if (input.stateDirPopulated === false) return "unpaired";
  const hb = input.heartbeat;
  const hasInboundEvidence =
    !!hb &&
    (isParseableTimestamp(hb.lastInboundAt) ||
      (hb.messagesHandled !== null && hb.messagesHandled > 0));
  if (hb && !hasInboundEvidence) return "idle";
  if (!hb) {
    return input.stateDirPopulated === true ? "idle" : "unknown";
  }
  if (signals.some((s) => s.label === "Noise WebSocket" && s.severity === "fail")) {
    return "idle";
  }
  // A heartbeat that claims a recent inbound is not enough to declare
  // healthy when any signal (bridge process, log, policy cross-check) is
  // still failing — that combination is exactly the #4386 shape where the
  // recorded heartbeat is stale relative to the live bridge state. Fall
  // back to "idle" so the exit code stays non-zero and the operator sees
  // the failing signal.
  if (signals.some((s) => s.severity === "fail")) return "idle";
  return "healthy";
}

function buildHints(verdict: WhatsappVerdict, input: WhatsappProbeInput): string[] {
  const hints: string[] = [];
  switch (verdict) {
    case "healthy":
      hints.push(
        "If the agent stops responding, re-run channels status — `lastInboundAt` going stale is the first NemoClaw-visible symptom.",
      );
      break;
    case "idle":
      hints.push(
        "Paired channel but no inbound event was observed. Send a test message from a paired phone and re-run.",
        "If inbound stays unreported, restart the bridge and re-check `nemoclaw <sandbox> logs --follow` for `401`, `getMessage`, or `connection.update` warnings.",
      );
      break;
    case "unpaired":
      hints.push(
        input.agent === "hermes"
          ? "Run `hermes whatsapp` inside the sandbox and scan the QR with your phone."
          : "Run `openclaw channels login --channel whatsapp` inside the sandbox and scan the QR with your phone.",
      );
      break;
    case "policy_gap":
      hints.push(
        "WhatsApp Web requires a raw L4 CONNECT tunnel for `web.whatsapp.com` — install the preset, then rebuild.",
      );
      break;
    case "config_gap":
      hints.push("Run `nemoclaw <sandbox> channels add whatsapp` to enable the channel.");
      break;
    case "probe_failed":
      hints.push(
        "Start the sandbox and verify the OpenShell gateway is healthy, then re-run channels status.",
      );
      break;
    case "unknown":
      hints.push(
        "Diagnostic evidence was insufficient. Try rebuilding the sandbox, then re-run channels status after pairing.",
      );
      break;
  }
  return hints;
}

export function evaluateWhatsappDiagnostics(input: WhatsappProbeInput): WhatsappDiagnosticReport {
  const signals: DiagnosticSignal[] = [
    configCoverageSignal(input),
    pairingSignal(input),
    bridgeProcessSignal(input),
    websocketSignal(input),
    inboundSignal(input),
    policyCoverageSignal(input),
  ];
  const logs = logSignals(input);
  if (logs) signals.push(logs);

  const verdict = pickVerdict(signals, input);
  return {
    schemaVersion: 1,
    channel: "whatsapp",
    agent: input.agent,
    verdict,
    probedAt: input.probedAt,
    signals,
    heartbeat: input.heartbeat,
    hints: buildHints(verdict, input),
  };
}

// Heartbeat shape varies across bridges; accept any of the documented field
// names without re-keying so additional bridges only need to teach this
// function their alias.
type RawHeartbeat = Record<string, unknown>;

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Connection-state values we are willing to surface to the host
// diagnostic. Anything else (including suspiciously long strings) is
// reduced to "other" so bridges that pack arbitrary text into these
// fields cannot leak it.
const SAFE_CONNECTION_STATES = new Set([
  "open",
  "connected",
  "connecting",
  "reconnecting",
  "close",
  "closed",
  "closing",
  "logging_out",
  "logged_out",
  "starting",
  "stopped",
  "unknown",
]);

function sanitizeConnectionState(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized.length > 32) return "other";
  return SAFE_CONNECTION_STATES.has(normalized) ? normalized : "other";
}

// Categorize the bridge's free-text error/note field without copying its
// contents. The goal is to surface enough signal for an operator to
// recognize the failure mode while never forwarding strings that could
// contain phone numbers, message bodies, or tokens.
function categorizeNote(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  if (/(401|unauthor)/.test(normalized)) return "unauthorized";
  if (/(logged ?out|logout|loggedout)/.test(normalized)) return "logged-out";
  if (/(rate ?limit|429|too many)/.test(normalized)) return "rate-limited";
  if (/(connection.*close|disconnect|stream.*close)/.test(normalized)) {
    return "connection-closed";
  }
  if (/(qr.*expired|qr.*timeout)/.test(normalized)) return "qr-expired";
  return "other";
}

// Heartbeat files are written by code outside NemoClaw's control. Drop any
// `lastInboundAt` value that is not strict ISO 8601 — `Date.parse` accepts
// loose values such as a bare integer or `Date.toString()` output with
// parenthesized text, which the diagnostic would later echo through
// `channels status --json` despite the redaction guarantee. Re-emit the
// canonical `toISOString()` form so the rendered output is deterministic
// regardless of the bridge's exact serialization.
const STRICT_ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function sanitizeTimestamp(value: string | null): string | null {
  if (value === null) return null;
  if (!STRICT_ISO_8601.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function parseWhatsappHeartbeat(
  raw: string,
): { heartbeat: WhatsappHeartbeat } | { parseError: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The original `err.message` from `JSON.parse` can include a snippet of
    // the offending input, which may contain message bodies or phone
    // numbers when the bridge wrote a corrupt heartbeat. Surface a fixed
    // string instead so the rendered diagnostic never echoes arbitrary
    // sandbox-owned file contents back to the host.
    return { parseError: "heartbeat is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { parseError: "heartbeat JSON must be an object" };
  }
  const record = parsed as RawHeartbeat;
  const lastInboundAt = sanitizeTimestamp(
    readString(record.lastInboundAt) ??
      readString(record.last_inbound_at) ??
      readString(record.lastInboundMessageAt) ??
      readString(record.lastMessageAt),
  );
  const messagesHandled =
    readNumber(record.messagesHandled) ??
    readNumber(record.messages_handled) ??
    readNumber(record.inboundCount) ??
    readNumber(record.inbound_count);
  const rawConnectionState =
    readString(record.connectionState) ??
    readString(record.connection_state) ??
    readString(record.wsState) ??
    readString(record.state);
  const rawNote =
    readString(record.note) ?? readString(record.lastError) ?? readString(record.error);
  return {
    heartbeat: {
      lastInboundAt,
      messagesHandled,
      connectionState: sanitizeConnectionState(rawConnectionState),
      noteCategory: categorizeNote(rawNote),
    },
  };
}

// Map well-known bridge log keywords to short summary phrases. The probe
// caller never forwards full log lines, so this list is intentionally narrow
// and avoids anything that could carry message bodies or phone numbers.
const LOG_PATTERNS: Array<{ pattern: RegExp; summary: string }> = [
  { pattern: /connection\.open|connection opened|ws open/i, summary: "connection.open" },
  { pattern: /connection\.close|connection closed|ws close/i, summary: "connection.close" },
  { pattern: /401\b|unauthorized/i, summary: "401 unauthorized" },
  { pattern: /qr\b.*(expired|timeout)/i, summary: "qr expired" },
  { pattern: /restartRequired|loggedOut|logged out/i, summary: "session logged out" },
  {
    pattern: /getMessage.*missing|message-not-found/i,
    summary: "getMessage miss (out-of-order delivery)",
  },
];

export function summarizeWhatsappLogLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    for (const { pattern, summary } of LOG_PATTERNS) {
      if (pattern.test(line) && !seen.has(summary)) {
        seen.add(summary);
        out.push(summary);
      }
    }
  }
  return out;
}
