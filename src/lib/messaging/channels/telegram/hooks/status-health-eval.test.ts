// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateTelegramDiagnostics,
  parseTelegramBreadcrumbs,
  type TelegramBreadcrumbs,
  type TelegramProbeInput,
} from "./status-health-eval";

function baseInput(overrides: Partial<TelegramProbeInput> = {}): TelegramProbeInput {
  return {
    agent: "openclaw",
    probeReachable: true,
    gatewayProcessAlive: true,
    breadcrumbs: null,
    probedAt: "2026-07-14T00:00:00.000Z",
    presetInRegistry: true,
    presetOnGateway: true,
    channelEnabledInRegistry: true,
    ...overrides,
  };
}

function breadcrumbs(overrides: Partial<TelegramBreadcrumbs> = {}): TelegramBreadcrumbs {
  return {
    providerReady: false,
    tokenRejected: false,
    credentialUnresolved: false,
    startupFailedNetwork: false,
    startupHttpError: null,
    bridgeNotStarted: false,
    inboundReceived: false,
    ...overrides,
  };
}

describe("evaluateTelegramDiagnostics verdict", () => {
  it("reports healthy when the provider is ready and inbound was observed (#6743)", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ providerReady: true, inboundReceived: true }) }),
    );
    expect(report.verdict).toBe("healthy");
  });

  it("reports idle when ready but no inbound was observed (#6743)", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ providerReady: true }) }),
    );
    expect(report.verdict).toBe("idle");
  });

  it("distinguishes a rejected token from a network failure (#6743)", () => {
    const rejected = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ tokenRejected: true }) }),
    );
    expect(rejected.verdict).toBe("token_rejected");

    const credential = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ credentialUnresolved: true }) }),
    );
    expect(credential.verdict).toBe("token_rejected");

    const unreachable = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ startupFailedNetwork: true }) }),
    );
    expect(unreachable.verdict).toBe("unreachable");
    expect(
      unreachable.signals.some((s) => s.label === "Bot API reachability" && s.severity === "fail"),
    ).toBe(true);
  });

  it("reports not_started when the gateway process is dead or the bridge never started", () => {
    expect(evaluateTelegramDiagnostics(baseInput({ gatewayProcessAlive: false })).verdict).toBe(
      "not_started",
    );
    expect(
      evaluateTelegramDiagnostics(
        baseInput({ breadcrumbs: breadcrumbs({ bridgeNotStarted: true }) }),
      ).verdict,
    ).toBe("not_started");
  });

  it("reports config_gap / policy_gap before any runtime verdict", () => {
    expect(
      evaluateTelegramDiagnostics(baseInput({ channelEnabledInRegistry: false })).verdict,
    ).toBe("config_gap");
    expect(evaluateTelegramDiagnostics(baseInput({ presetInRegistry: false })).verdict).toBe(
      "policy_gap",
    );
  });

  it("reports probe_failed when the sandbox could not be reached", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ probeReachable: false, gatewayProcessAlive: null, breadcrumbs: null }),
    );
    expect(report.verdict).toBe("probe_failed");
  });

  it("reports unknown when reachable but no conclusive startup breadcrumb", () => {
    const report = evaluateTelegramDiagnostics(baseInput({ breadcrumbs: breadcrumbs() }));
    expect(report.verdict).toBe("unknown");
  });

  it("never claims healthy while a runtime signal fails", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ providerReady: true, tokenRejected: true }) }),
    );
    expect(report.verdict).toBe("token_rejected");
  });

  it("reports unreachable (not not_started) when the bridge failed on a network error (#6743)", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({
        breadcrumbs: breadcrumbs({ startupFailedNetwork: true, bridgeNotStarted: true }),
      }),
    );
    expect(report.verdict).toBe("unreachable");
  });

  it("prefers a confirmed provider-ready over a stale bridge-did-not-start (#6743)", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ bridgeNotStarted: true, providerReady: true }) }),
    );
    expect(report.verdict).toBe("idle");
  });

  it("prefers a confirmed provider-ready over a transient network error (#6743)", () => {
    const report = evaluateTelegramDiagnostics(
      baseInput({ breadcrumbs: breadcrumbs({ startupFailedNetwork: true, providerReady: true }) }),
    );
    expect(report.verdict).toBe("idle");
  });
});

describe("parseTelegramBreadcrumbs", () => {
  it("returns null when no [telegram] line is present", () => {
    expect(
      parseTelegramBreadcrumbs(["[slack] [default] provider ready", "random line"]),
    ).toBeNull();
  });

  it("classifies the known startup phrases", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
    ]);
    expect(bc).toMatchObject({ providerReady: true, inboundReceived: true });
  });

  it("classifies a rejected token vs a network failure vs credential gap", () => {
    expect(
      parseTelegramBreadcrumbs([
        "[telegram] [default] Bot API rejected startup probe with HTTP 401; token invalid or credential placeholder unresolved",
      ]),
    ).toMatchObject({ tokenRejected: true });

    expect(
      parseTelegramBreadcrumbs(["[telegram] [default] Bot API startup probe failed: ETIMEDOUT"]),
    ).toMatchObject({ startupFailedNetwork: true });

    expect(
      parseTelegramBreadcrumbs([
        "[telegram] [default] credential placeholder configured but TELEGRAM_BOT_TOKEN is missing from runtime env",
      ]),
    ).toMatchObject({ credentialUnresolved: true });
  });

  it("captures a non-auth HTTP startup error code", () => {
    expect(
      parseTelegramBreadcrumbs(["[telegram] [default] Bot API startup probe returned HTTP 502"]),
    ).toMatchObject({ startupHttpError: 502 });
  });

  it("flags a bridge that did not start", () => {
    expect(
      parseTelegramBreadcrumbs(["[telegram] [default] bridge did not start within 15s"]),
    ).toMatchObject({ bridgeNotStarted: true });
  });

  it("classifies OpenClaw native (timestamped) network-failure lines (#6743)", () => {
    // A network failure outranks the bridge-did-not-start timeout it causes.
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T18:55:23.313+00:00 [telegram] deleteWebhook failed: Network request for 'deleteWebhook' failed!",
      "[telegram] [default] bridge did not start within 15s; check channels.telegram.enabled",
    ]);
    expect(bc).toMatchObject({ startupFailedNetwork: true, bridgeNotStarted: false });
  });

  it("treats a later inbound as recovery over a stale startup network failure (#6743)", () => {
    // Bridge started while the network was blocked, then recovered and received
    // a message — the latest evidence (inbound) must win over the stale failure.
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T19:51:41.423+00:00 [telegram] deleteWebhook failed: Network request for 'deleteWebhook' failed!",
      "[telegram] [default] bridge did not start within 15s",
      "2026-07-14T20:03:22.254+00:00 [telegram] [diag] isolated polling ingress started spool=/sandbox/.openclaw/telegram/ingress-spool-default",
      "2026-07-14T20:03:23.312+00:00 [telegram] Inbound message telegram:5209865443 -> @bot (direct, 2 chars)",
    ]);
    expect(bc).toMatchObject({
      providerReady: true,
      inboundReceived: true,
      startupFailedNetwork: false,
      bridgeNotStarted: false,
    });
  });

  it("treats a later network failure as the current state over an earlier inbound (#6743)", () => {
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T20:03:23.312+00:00 [telegram] Inbound message telegram:5209865443 -> @bot (direct, 2 chars)",
      "[telegram] transport attempt marked temporarily unhealthy for 10000ms (codes=UND_ERR_SOCKET)",
    ]);
    expect(bc).toMatchObject({ startupFailedNetwork: true, providerReady: false });
  });
});

describe("evaluateTelegramDiagnostics over real gateway-log windows (#6743)", () => {
  it("reports healthy for a bridge that recovered after a blocked startup", () => {
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T19:51:41.423+00:00 [telegram] deleteWebhook failed: Network request for 'deleteWebhook' failed!",
      "[telegram] [default] bridge did not start within 15s",
      "2026-07-14T20:03:22.254+00:00 [telegram] [diag] isolated polling ingress started spool=/sandbox/x",
      "2026-07-14T20:03:23.312+00:00 [telegram] Inbound message telegram:5209865443 -> @bot (direct, 2 chars)",
    ]);
    const report = evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc }));
    expect(report.verdict).toBe("healthy");
  });

  it("reports unreachable once the network fails again after working", () => {
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T20:03:23.312+00:00 [telegram] Inbound message telegram:5209865443 -> @bot (direct, 2 chars)",
      "[telegram] transport attempt marked temporarily unhealthy for 20000ms (codes=UND_ERR_SOCKET)",
    ]);
    const report = evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc }));
    expect(report.verdict).toBe("unreachable");
  });

  it("does not stay token_rejected when a later provider-ready follows a stale 401 (#6887)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] Bot API rejected startup probe with HTTP 401; token invalid or credential placeholder unresolved",
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
    ]);
    expect(bc).toMatchObject({
      tokenRejected: false,
      credentialUnresolved: false,
      providerReady: true,
      inboundReceived: true,
    });
    expect(evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc })).verdict).toBe("healthy");
  });

  it("reports token_rejected when a 401 is the latest evidence after a working bridge (#6887)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
      "[telegram] [default] Bot API rejected startup probe with HTTP 401; token invalid",
    ]);
    expect(bc).toMatchObject({ tokenRejected: true, providerReady: false });
    expect(evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc })).verdict).toBe(
      "token_rejected",
    );
  });

  it("clears a stale HTTP 5xx error once a later provider-ready follows (#6887)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] Bot API startup probe returned HTTP 502",
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
    ]);
    expect(bc).toMatchObject({
      startupHttpError: null,
      providerReady: true,
      inboundReceived: true,
    });
    const report = evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc }));
    expect(report.verdict).toBe("healthy");
    // A stale 5xx must not surface as a warn while the verdict reads healthy.
    const reach = report.signals.find((s) => s.label === "Bot API reachability");
    expect(reach?.severity).toBe("ok");
  });

  it("does not carry a pre-outage inbound across a later failure into healthy (#6888)", () => {
    // inbound → network failure → provider ready: the bridge recovered but no
    // inbound has arrived since, so delivery is idle, not healthy.
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
      "[telegram] [default] Bot API startup probe failed: ETIMEDOUT",
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
    ]);
    expect(bc).toMatchObject({ providerReady: true, inboundReceived: false });
    expect(evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc })).verdict).toBe("idle");
  });

  it("reports healthy again once an inbound arrives after the recovery (#6888)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] inbound update received (update_id=present; message_id=present)",
      "[telegram] [default] Bot API startup probe failed: ETIMEDOUT",
      "[telegram] [default] provider ready (Bot API reachable; agent replies use inference.local)",
      "[telegram] Inbound message telegram:5209865443 -> @bot (direct, 3 chars)",
    ]);
    expect(bc).toMatchObject({ providerReady: true, inboundReceived: true });
    expect(evaluateTelegramDiagnostics(baseInput({ breadcrumbs: bc })).verdict).toBe("healthy");
  });

  it("honors a later HTTP 5xx over an earlier network failure (#6888)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] Bot API startup probe failed: ETIMEDOUT",
      "[telegram] [default] Bot API startup probe returned HTTP 502",
    ]);
    expect(bc).toMatchObject({ startupHttpError: 502, startupFailedNetwork: false });
  });

  it("honors a later HTTP 5xx over an earlier token rejection (#6888)", () => {
    const bc = parseTelegramBreadcrumbs([
      "[telegram] [default] Bot API rejected startup probe with HTTP 401; token invalid",
      "[telegram] [default] Bot API startup probe returned HTTP 502",
    ]);
    expect(bc).toMatchObject({ startupHttpError: 502, tokenRejected: false });
  });
});
