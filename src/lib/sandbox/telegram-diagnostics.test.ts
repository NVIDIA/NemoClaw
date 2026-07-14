// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  evaluateTelegramDiagnostics,
  parseTelegramBreadcrumbs,
  type TelegramBreadcrumbs,
  type TelegramProbeInput,
} from "./telegram-diagnostics";

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
    const bc = parseTelegramBreadcrumbs([
      "2026-07-14T18:55:23.313+00:00 [telegram] deleteWebhook failed: Network request for 'deleteWebhook' failed!",
      "[telegram] [default] bridge did not start within 15s; check channels.telegram.enabled",
    ]);
    expect(bc).toMatchObject({ startupFailedNetwork: true, bridgeNotStarted: true });
  });
});
