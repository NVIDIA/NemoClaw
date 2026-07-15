// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers that translate raw probe evidence collected from inside a
 * sandbox into a structured Telegram channel-health report.
 *
 * Consumed by the `telegram.statusHealth` status hook (see `status-health.ts`);
 * this module never touches the filesystem, child processes, or the clock so
 * the evaluation can be exercised hermetically from fixtures.
 *
 * Telegram's bridge is an in-process poller inside the OpenClaw gateway, not a
 * separate process with a heartbeat file (unlike WhatsApp's Baileys bridge). So
 * "liveness" is inferred from two places the gateway already produces:
 *   1. the gateway process being alive (pgrep), and
 *   2. the `[telegram] [default] …` breadcrumbs the runtime diagnostics preload
 *      writes to /tmp/gateway.log (see ../runtime/telegram-diagnostics.ts).
 * We deliberately do NOT run our own getMe from the probe: verified live, the
 * egress MITM proxy refuses a raw `curl` at CONNECT (HTTP 403) while authorizing
 * only the gateway's instrumented Node egress, and the resolved token never
 * leaves that path. The gateway already performs getMe/getUpdates and logs the
 * outcome — we read that outcome instead.
 */

import type { ChannelHealthReport, DiagnosticSignal } from "../../channel-health";

export type TelegramVerdict =
  | "healthy"
  | "idle"
  | "token_rejected"
  | "unreachable"
  | "not_started"
  | "policy_gap"
  | "config_gap"
  | "unknown"
  | "probe_failed";

/**
 * Classified `[telegram] [default] …` breadcrumbs parsed from the gateway
 * log. Every field is a boolean/number derived from a fixed log phrase; no
 * raw log text is carried through so message bodies / tokens cannot leak.
 */
export type TelegramBreadcrumbs = {
  // "[telegram] [default] provider ready (Bot API reachable …)"
  providerReady: boolean;
  // "… Bot API rejected startup probe with HTTP 401/404; token invalid …"
  tokenRejected: boolean;
  // "… credential placeholder … missing from runtime env" / "… mismatch"
  credentialUnresolved: boolean;
  // Network failure reaching the Bot API — either the diagnostics preload's
  // "… Bot API startup probe failed: <network error>" or OpenClaw's own
  // "… Network request for '<method>' failed" / "recoverable network error".
  startupFailedNetwork: boolean;
  // "… Bot API startup probe returned HTTP <n>" (n>=300, not 401/404)
  startupHttpError: number | null;
  // "… bridge did not start within Ns"
  bridgeNotStarted: boolean;
  // "… inbound update received (update_id=…)"
  inboundReceived: boolean;
};

export type TelegramProbeInput = {
  // Agent owning the sandbox: "openclaw", "hermes", etc. Used for hint text.
  agent: string;
  // Whether the orchestrator could run `openshell sandbox exec` at all.
  probeReachable: boolean;
  // True when the OpenClaw gateway process (which hosts the telegram poller)
  // was observed running. Null when the process probe could not complete.
  gatewayProcessAlive: boolean | null;
  // Parsed startup/poll breadcrumbs, or null when no `[telegram]` line was
  // found in the tailed gateway log window.
  breadcrumbs: TelegramBreadcrumbs | null;
  // ISO timestamp captured by the orchestrator when the probe ran.
  probedAt: string;
  // Whether the telegram preset is recorded in the sandbox registry.
  presetInRegistry: boolean;
  // Whether the telegram preset's network policy is loaded on the gateway,
  // or null when the gateway could not be reached.
  presetOnGateway: boolean | null;
  // Whether the telegram channel is recorded in the registry messaging plan.
  channelEnabledInRegistry: boolean;
};

export type TelegramDiagnosticReport = ChannelHealthReport & {
  channel: "telegram";
  verdict: TelegramVerdict;
};

function configCoverageSignal(input: TelegramProbeInput): DiagnosticSignal {
  if (!input.channelEnabledInRegistry) {
    return {
      label: "Channel registration",
      severity: "fail",
      detail: "telegram is not in the sandbox messaging plan",
      hint: "run `nemoclaw <sandbox> channels add telegram`",
    };
  }
  return {
    label: "Channel registration",
    severity: "ok",
    detail: "telegram channel registered for the sandbox",
  };
}

function policyCoverageSignal(input: TelegramProbeInput): DiagnosticSignal {
  if (input.presetOnGateway === false && input.presetInRegistry) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "telegram preset recorded locally but missing from the gateway policy",
      hint: "rebuild the sandbox so the preset is reapplied to the OpenShell gateway",
    };
  }
  if (!input.presetInRegistry) {
    return {
      label: "Policy coverage",
      severity: "fail",
      detail: "telegram preset is not applied to the sandbox",
      hint: "run `nemoclaw <sandbox> policy-add telegram` and rebuild the sandbox",
    };
  }
  if (input.presetOnGateway === null) {
    return {
      label: "Policy coverage",
      severity: "info",
      detail: "telegram preset recorded locally; gateway is unreachable for cross-check",
    };
  }
  return {
    label: "Policy coverage",
    severity: "ok",
    detail: "telegram preset applied and loaded on the gateway",
  };
}

function bridgeProcessSignal(input: TelegramProbeInput): DiagnosticSignal {
  if (input.gatewayProcessAlive === null) {
    return {
      label: "Bridge process",
      severity: "info",
      detail: "could not enumerate sandbox processes",
    };
  }
  if (input.gatewayProcessAlive === false) {
    return {
      label: "Bridge process",
      severity: "fail",
      detail: "no OpenClaw gateway process observed — telegram poller is not running",
      hint: "check `nemoclaw <sandbox> logs --follow` for gateway startup errors",
    };
  }
  return {
    label: "Bridge process",
    severity: "ok",
    detail: "gateway process running (telegram poller host)",
  };
}

/**
 * The token-vs-network distinction the VDR item asked for. Reads the
 * gateway's own getMe/getUpdates outcome breadcrumbs.
 */
function reachabilitySignal(input: TelegramProbeInput): DiagnosticSignal {
  const bc = input.breadcrumbs;
  if (!bc) {
    return {
      label: "Bot API reachability",
      severity: input.gatewayProcessAlive === false ? "fail" : "info",
      detail: "no telegram startup breadcrumb in the gateway log window",
      hint: "the poller may not have started yet — re-run after the gateway settles, or check logs",
    };
  }
  if (bc.credentialUnresolved) {
    return {
      label: "Bot API reachability",
      severity: "fail",
      detail:
        "credential placeholder is unresolved — TELEGRAM_BOT_TOKEN missing/mismatched at runtime",
      hint: "reset the telegram credential and rebuild: `nemoclaw credentials reset TELEGRAM_BOT_TOKEN && nemoclaw <sandbox> rebuild`",
    };
  }
  if (bc.tokenRejected) {
    return {
      label: "Bot API reachability",
      severity: "fail",
      detail: "Telegram rejected the bot token (HTTP 401/404)",
      hint: "verify the token from @BotFather, reset the credential, then rebuild",
    };
  }
  if (bc.startupFailedNetwork) {
    return {
      label: "Bot API reachability",
      severity: "fail",
      detail: "could not reach api.telegram.org from the sandbox (network error)",
      hint: "check the telegram egress policy is loaded and the network allows api.telegram.org",
    };
  }
  if (bc.startupHttpError !== null) {
    return {
      label: "Bot API reachability",
      severity: "warn",
      detail: `Telegram startup probe returned HTTP ${bc.startupHttpError}`,
      hint: "check `nemoclaw <sandbox> logs --follow`",
    };
  }
  if (bc.providerReady) {
    return {
      label: "Bot API reachability",
      severity: "ok",
      detail: "gateway reached api.telegram.org and the token was accepted",
    };
  }
  if (bc.bridgeNotStarted) {
    return {
      label: "Bot API reachability",
      severity: "warn",
      detail: "bridge did not confirm startup within its probe window",
      hint: "check `nemoclaw <sandbox> logs --follow`; rebuild if it stays silent",
    };
  }
  return {
    label: "Bot API reachability",
    severity: "info",
    detail: "startup outcome not conclusive from the log window",
  };
}

function inboundSignal(input: TelegramProbeInput): DiagnosticSignal {
  const bc = input.breadcrumbs;
  if (!bc || !bc.providerReady) {
    return {
      label: "Inbound delivery",
      severity: "info",
      detail: "not evaluated (provider not confirmed ready)",
    };
  }
  if (bc.inboundReceived) {
    return {
      label: "Inbound delivery",
      severity: "ok",
      detail: "at least one inbound getUpdates delivery was observed",
    };
  }
  return {
    label: "Inbound delivery",
    severity: "info",
    detail: "provider polling; no inbound update observed in the log window",
    hint: "send a message to the bot from an allowed Telegram account, then re-run",
  };
}

function pickVerdict(signals: DiagnosticSignal[], input: TelegramProbeInput): TelegramVerdict {
  if (!input.probeReachable) return "probe_failed";
  if (signals.some((s) => s.label === "Channel registration" && s.severity === "fail")) {
    return "config_gap";
  }
  if (signals.some((s) => s.label === "Policy coverage" && s.severity === "fail")) {
    return "policy_gap";
  }
  const bc = input.breadcrumbs;
  // Hard failures first: a bad token or a dead gateway process won't self-heal.
  if (bc?.credentialUnresolved || bc?.tokenRejected) return "token_rejected";
  if (input.gatewayProcessAlive === false) return "not_started";
  // A confirmed `provider ready` means the bridge reached Telegram and the
  // token works — it outranks the soft "did not start (yet)" and transient
  // network-blip signals, which may be older log lines from a slow start.
  if (bc?.providerReady) {
    return bc.inboundReceived ? "healthy" : "idle";
  }
  if (bc?.startupFailedNetwork) return "unreachable";
  if (bc?.bridgeNotStarted) return "not_started";
  return "unknown";
}

function buildHints(verdict: TelegramVerdict): string[] {
  switch (verdict) {
    case "healthy":
      return [
        "Telegram is reachable, the token is valid, and inbound updates are being delivered.",
      ];
    case "idle":
      return [
        "Provider is polling and reachable, but no inbound update was seen. Send a message from an allowed account and re-run.",
      ];
    case "token_rejected":
      return [
        "Telegram rejected the token. Reset the credential and rebuild — this will not recover on its own.",
      ];
    case "unreachable":
      return [
        "The sandbox could not reach api.telegram.org. Confirm the telegram egress policy is loaded and the corporate network allows Telegram.",
      ];
    case "not_started":
      return [
        "The telegram poller did not start. Check `nemoclaw <sandbox> logs --follow` and rebuild if needed.",
      ];
    case "policy_gap":
      return ["Run `nemoclaw <sandbox> policy-add telegram`, then rebuild."];
    case "config_gap":
      return ["Run `nemoclaw <sandbox> channels add telegram` to enable the channel."];
    case "probe_failed":
      return [
        "Start the sandbox and verify the OpenShell gateway is healthy, then re-run channels status.",
      ];
    case "unknown":
      return [
        "Startup outcome was not conclusive. Re-run after the gateway settles, or rebuild the sandbox.",
      ];
  }
}

export function evaluateTelegramDiagnostics(input: TelegramProbeInput): TelegramDiagnosticReport {
  const signals: DiagnosticSignal[] = [
    configCoverageSignal(input),
    policyCoverageSignal(input),
    bridgeProcessSignal(input),
    reachabilitySignal(input),
    inboundSignal(input),
  ];
  const verdict = pickVerdict(signals, input);
  return {
    schemaVersion: 1,
    channel: "telegram",
    agent: input.agent,
    verdict,
    probedAt: input.probedAt,
    signals,
    hints: buildHints(verdict),
  };
}

// ── Breadcrumb parser ────────────────────────────────────────────────────
// Turns the tailed `[telegram] [default] …` gateway-log lines into the
// classified TelegramBreadcrumbs. Fixed phrase matching only; never carries
// raw log text forward.

export function parseTelegramBreadcrumbs(logLines: readonly string[]): TelegramBreadcrumbs | null {
  // Accept both the preload's `[telegram] [default] …` lines and OpenClaw's
  // timestamped `… [telegram] …` gateway lines (which carry native network
  // errors), so a network-blocked channel is classified rather than left blank.
  const telegramLines = logLines.filter((line) => /\[telegram\]/.test(line));
  if (telegramLines.length === 0) return null;
  const bc: TelegramBreadcrumbs = {
    providerReady: false,
    tokenRejected: false,
    credentialUnresolved: false,
    startupFailedNetwork: false,
    startupHttpError: null,
    bridgeNotStarted: false,
    inboundReceived: false,
  };
  // Tailed lines are in chronological (append) order, so the *latest* matching
  // line reflects the current reachability state. A stale startup network
  // failure must not outrank a later "reached Telegram" line (a bridge that
  // started while blocked then recovered), nor vice-versa (a channel that
  // worked then got blocked again). Track the last index of each state and let
  // the most recent win; a network failure outranks the "bridge did not start"
  // timeout it causes. `provider ready` / `inbound update received` are preload
  // phrases; `Inbound message telegram:` / `isolated polling ingress started`
  // are OpenClaw's own positive lines; `Network request … failed` /
  // `temporarily unhealthy` / `UND_ERR_SOCKET` are its transport-failure lines.
  const REACHED =
    /\bprovider ready\b|inbound update received|inbound message telegram|isolated polling ingress started/i;
  const NETWORK_FAIL =
    /startup probe failed|network request for .+ failed|recoverable network error|temporarily unhealthy|UND_ERR_SOCKET/i;
  let lastReached = -1;
  let lastNetworkFail = -1;
  let lastBridgeNotStarted = -1;
  let lastTokenRejected = -1;
  let lastCredentialUnresolved = -1;
  let lastHttpError = -1;
  let lastHttpErrorCode: number | null = null;
  let lastInbound = -1;
  telegramLines.forEach((line, index) => {
    const httpErr = /startup probe returned HTTP\s+(\d{3})/i.exec(line);
    if (httpErr) {
      lastHttpError = index;
      lastHttpErrorCode = Number(httpErr[1]);
    }
    if (/inbound update received|inbound message telegram/i.test(line)) lastInbound = index;
    if (REACHED.test(line)) lastReached = index;
    if (NETWORK_FAIL.test(line)) lastNetworkFail = index;
    if (/bridge did not start within/i.test(line)) lastBridgeNotStarted = index;
    if (/rejected startup probe with HTTP\s+(401|404)/i.test(line)) lastTokenRejected = index;
    if (/credential placeholder.*(missing|mismatch|unresolved)/i.test(line)) {
      lastCredentialUnresolved = index;
    }
  });
  // The most recent evidence wins (a `reached` positive wins ties). A token
  // rejection or unresolved credential is a cause, honored only when it is the
  // latest evidence over any later "reached Telegram" line — so a stale 401
  // before a currently working bridge is not reported as token_rejected. Among
  // failures, a token/network cause outranks the bridge-did-not-start timeout it
  // produces; the latest of token vs network wins.
  // The single latest cause wins: token/credential rejection, a network
  // failure, and a non-auth HTTP 5xx are peers ranked purely by recency, so a
  // later 502 supersedes an earlier 401/timeout (#6888). Each of these outranks
  // the bridge-did-not-start timeout they produce, so bridge is reported only
  // when it is the sole cause. A later `reached` line still supersedes all of
  // them (a stale cause before a currently working bridge is not reported).
  const lastCause = Math.max(
    lastTokenRejected,
    lastCredentialUnresolved,
    lastNetworkFail,
    lastHttpError,
  );
  const lastEvidence = Math.max(lastReached, lastCause, lastBridgeNotStarted);
  if (lastReached !== -1 && lastReached >= lastEvidence) {
    bc.providerReady = true;
  } else if (lastCause !== -1) {
    if (lastHttpError === lastCause) {
      bc.startupHttpError = lastHttpErrorCode;
    } else if (lastNetworkFail === lastCause) {
      bc.startupFailedNetwork = true;
    } else if (lastCredentialUnresolved > lastTokenRejected) {
      // A 401 line also carries "credential placeholder unresolved", so on a tie
      // prefer tokenRejected; credentialUnresolved wins only when its own line
      // (TELEGRAM_BOT_TOKEN missing from env) is strictly later.
      bc.credentialUnresolved = true;
    } else {
      bc.tokenRejected = true;
    }
  } else if (lastBridgeNotStarted !== -1) {
    bc.bridgeNotStarted = true;
  }
  // Inbound delivery counts as "current" only when the latest inbound is newer
  // than the latest outage boundary. A stale inbound from before a later
  // failure/recovery must not read as healthy delivery — a recovered bridge
  // with no inbound since recovery is idle, not healthy (#6888).
  const lastOutage = Math.max(
    lastNetworkFail,
    lastBridgeNotStarted,
    lastTokenRejected,
    lastCredentialUnresolved,
    lastHttpError,
  );
  bc.inboundReceived = lastInbound !== -1 && lastInbound > lastOutage;
  return bc;
}
