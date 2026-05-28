// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  evaluateWhatsappDiagnostics,
  parseWhatsappHeartbeat,
  summarizeWhatsappLogLines,
  type WhatsappProbeInput,
} from "./whatsapp-diagnostics";

const PROBED_AT = "2026-05-28T04:00:00.000Z";

function baseInput(overrides: Partial<WhatsappProbeInput> = {}): WhatsappProbeInput {
  return {
    agent: "openclaw",
    stateDirs: ["/sandbox/.openclaw/whatsapp"],
    stateDirPopulated: true,
    heartbeat: null,
    heartbeatParseError: null,
    bridgeProcessAlive: true,
    recentLogSignals: [],
    probeReachable: true,
    probedAt: PROBED_AT,
    presetInRegistry: true,
    presetOnGateway: true,
    channelEnabledInRegistry: true,
    ...overrides,
  };
}

describe("evaluateWhatsappDiagnostics", () => {
  it("returns probe_failed when the sandbox cannot be reached", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        probeReachable: false,
        stateDirPopulated: null,
        bridgeProcessAlive: null,
        presetOnGateway: null,
      }),
    );
    expect(report.verdict).toBe("probe_failed");
    expect(report.signals.find((s) => s.label === "Pairing / session")?.severity).toBe("info");
    expect(report.hints[0]).toMatch(/Start the sandbox/);
  });

  it("returns config_gap when the channel is not registered for the sandbox", () => {
    const report = evaluateWhatsappDiagnostics(baseInput({ channelEnabledInRegistry: false }));
    expect(report.verdict).toBe("config_gap");
    expect(
      report.signals.find((s) => s.label === "Channel registration")?.severity,
    ).toBe("fail");
    expect(report.hints[0]).toMatch(/channels add whatsapp/);
  });

  it("returns policy_gap when the whatsapp preset is missing", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({ presetInRegistry: false, presetOnGateway: false }),
    );
    expect(report.verdict).toBe("policy_gap");
    const policy = report.signals.find((s) => s.label === "Policy coverage");
    expect(policy?.severity).toBe("fail");
    expect(policy?.detail).toMatch(/preset is not applied/);
  });

  it("returns unpaired when the bridge state directory is empty", () => {
    const report = evaluateWhatsappDiagnostics(baseInput({ stateDirPopulated: false }));
    expect(report.verdict).toBe("unpaired");
    const pairing = report.signals.find((s) => s.label === "Pairing / session");
    expect(pairing?.severity).toBe("warn");
    expect(pairing?.hint).toMatch(/QR code/);
  });

  it("returns the hermes-flavored pairing hint when the agent is hermes", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({ agent: "hermes", stateDirPopulated: false }),
    );
    const pairing = report.signals.find((s) => s.label === "Pairing / session");
    expect(pairing?.hint).toMatch(/hermes whatsapp/);
    expect(report.hints.join(" ")).toMatch(/hermes whatsapp/);
  });

  it("returns idle when paired with a live WebSocket but no inbound event observed", () => {
    // This is the exact #4386 shape: pairing is fine, WebSocket is up, but
    // lastInboundAt is still null. We MUST NOT report this as healthy.
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: null,
          messagesHandled: 0,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    expect(report.verdict).toBe("idle");
    const inbound = report.signals.find((s) => s.label === "Inbound delivery");
    expect(inbound?.severity).toBe("warn");
    expect(inbound?.detail).toMatch(/no inbound message observed/);
    expect(inbound?.detail).toMatch(/messagesHandled=0/);
  });

  it("returns healthy when paired and a recent inbound event is present", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: "2026-05-28T03:59:30.000Z",
          messagesHandled: 5,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    expect(report.verdict).toBe("healthy");
    const inbound = report.signals.find((s) => s.label === "Inbound delivery");
    expect(inbound?.severity).toBe("ok");
    expect(inbound?.detail).toMatch(/messagesHandled=5/);
  });

  it("downgrades a stale-but-present inbound timestamp to info", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: "2026-05-28T03:00:00.000Z",
          messagesHandled: 12,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    const inbound = report.signals.find((s) => s.label === "Inbound delivery");
    expect(inbound?.severity).toBe("info");
    expect(inbound?.detail).toMatch(/60m ago/);
  });

  it("treats heartbeat parse errors as a warn signal without claiming healthy", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: null,
        heartbeatParseError: "Unexpected token",
      }),
    );
    expect(report.verdict).not.toBe("healthy");
    const ws = report.signals.find((s) => s.label === "Noise WebSocket");
    expect(ws?.severity).toBe("warn");
    expect(ws?.detail).toMatch(/unparseable/);
  });

  it("reports fail when no bridge process is running and no heartbeat is present", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({ heartbeat: null, bridgeProcessAlive: false }),
    );
    const ws = report.signals.find((s) => s.label === "Noise WebSocket");
    expect(ws?.severity).toBe("fail");
    const proc = report.signals.find((s) => s.label === "Bridge process");
    expect(proc?.severity).toBe("fail");
    expect(report.verdict).toBe("idle");
  });

  it("does not return healthy when the heartbeat is recent but the bridge process is missing", () => {
    // The #4386 shape: a paired sandbox can leave a stale heartbeat on disk
    // claiming connection.open + recent inbound while the actual bridge
    // process has died. Never let that combination render as healthy.
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: "2026-05-28T03:59:30.000Z",
          messagesHandled: 4,
          connectionState: "open",
          noteCategory: null,
        },
        bridgeProcessAlive: false,
      }),
    );
    const proc = report.signals.find((s) => s.label === "Bridge process");
    expect(proc?.severity).toBe("fail");
    expect(report.verdict).not.toBe("healthy");
    expect(report.verdict).toBe("idle");
  });

  it("warns when the preset is recorded locally but missing from the gateway", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({ presetInRegistry: true, presetOnGateway: false }),
    );
    const policy = report.signals.find((s) => s.label === "Policy coverage");
    expect(policy?.severity).toBe("fail");
    expect(policy?.detail).toMatch(/missing from the gateway/);
  });

  it("does not downgrade a healthy heartbeat when pgrep could not enumerate the bridge", () => {
    // Regression guard: when the WhatsApp adapter runs inside the parent
    // gateway process (no `whatsapp`/`baileys` substring in argv), the
    // probe cannot enumerate it and reports `bridgeProcessAlive: null`.
    // The diagnostic must keep the verdict healthy as long as the
    // heartbeat shows recent inbound + an open WebSocket.
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        bridgeProcessAlive: null,
        heartbeat: {
          lastInboundAt: "2026-05-28T03:59:30.000Z",
          messagesHandled: 6,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    expect(report.verdict).toBe("healthy");
    const proc = report.signals.find((s) => s.label === "Bridge process");
    expect(proc?.severity).toBe("info");
  });

  it("treats a missing local preset as fail even when the gateway is unreachable", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({ presetInRegistry: false, presetOnGateway: null }),
    );
    const policy = report.signals.find((s) => s.label === "Policy coverage");
    expect(policy?.severity).toBe("fail");
    expect(report.verdict).toBe("policy_gap");
  });

  it("does not return healthy when lastInboundAt is unparseable text and counters are absent", () => {
    // Regression guard: an earlier draft accepted any non-null string as
    // delivery evidence, so a heartbeat that wrote a free-form
    // `lastInboundAt` would render as healthy and leak the raw string in
    // the rendered detail. The diagnostic must instead fall back to idle.
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: "never",
          messagesHandled: null,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    const inbound = report.signals.find((s) => s.label === "Inbound delivery");
    expect(inbound?.severity).toBe("warn");
    expect(inbound?.detail).not.toMatch(/never/);
    expect(report.verdict).toBe("idle");
  });

  it("does not mark inbound as 'no message observed' when messagesHandled>0 without lastInboundAt", () => {
    // Some bridge builds publish the counter without a timestamp. That
    // already proves inbound delivery, so the verdict should not fall back
    // to idle just because the timestamp field is missing.
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        heartbeat: {
          lastInboundAt: null,
          messagesHandled: 3,
          connectionState: "open",
          noteCategory: null,
        },
      }),
    );
    const inbound = report.signals.find((s) => s.label === "Inbound delivery");
    expect(inbound?.severity).toBe("info");
    expect(inbound?.detail).toMatch(/messagesHandled=3/);
    expect(report.verdict).toBe("healthy");
  });

  it("includes a recent-log-signals row when any are observed", () => {
    const report = evaluateWhatsappDiagnostics(
      baseInput({
        recentLogSignals: ["connection.open", "401 unauthorized"],
      }),
    );
    const logs = report.signals.find((s) => s.label === "Recent log signals");
    expect(logs?.detail).toContain("connection.open");
    expect(logs?.detail).toContain("401 unauthorized");
  });
});

describe("parseWhatsappHeartbeat", () => {
  it("extracts canonical field names", () => {
    const result = parseWhatsappHeartbeat(
      JSON.stringify({
        lastInboundAt: "2026-05-28T03:59:00.000Z",
        messagesHandled: 7,
        connectionState: "open",
      }),
    );
    expect(result).toEqual({
      heartbeat: {
        lastInboundAt: "2026-05-28T03:59:00.000Z",
        messagesHandled: 7,
        connectionState: "open",
        noteCategory: null,
      },
    });
  });

  it("redacts free-text error fields to a category and accepts snake_case keys", () => {
    const result = parseWhatsappHeartbeat(
      JSON.stringify({
        last_inbound_at: "2026-05-28T03:50:00.000Z",
        inbound_count: "3",
        wsState: "connecting",
        lastError: "401 unauthorized for +14155551212",
      }),
    );
    expect(result).toEqual({
      heartbeat: {
        lastInboundAt: "2026-05-28T03:50:00.000Z",
        messagesHandled: 3,
        connectionState: "connecting",
        noteCategory: "unauthorized",
      },
    });
  });

  it("collapses unknown connection-state strings to 'other' so bridge text never leaks", () => {
    const result = parseWhatsappHeartbeat(
      JSON.stringify({
        connectionState: "hi +14155551212 message body 123",
        lastError: "rate limit exceeded",
      }),
    );
    expect(
      "heartbeat" in result &&
        result.heartbeat.connectionState === "other" &&
        result.heartbeat.noteCategory === "rate-limited",
    ).toBe(true);
  });

  it("returns a fixed parseError when the input is not valid JSON", () => {
    // The parser must never echo Node's `JSON.parse` error message because
    // it can include a snippet of the offending input (which may carry
    // phone numbers or message bodies for a corrupt heartbeat).
    const result = parseWhatsappHeartbeat("{not json with +14155551212 inside");
    expect(result).toEqual({ parseError: "heartbeat is not valid JSON" });
  });

  it("drops a non-timestamp lastInboundAt so it never reaches the JSON report", () => {
    const result = parseWhatsappHeartbeat(
      JSON.stringify({ lastInboundAt: "hi +14155551212 message body", messagesHandled: 0 }),
    );
    expect(
      "heartbeat" in result &&
        result.heartbeat.lastInboundAt === null &&
        result.heartbeat.messagesHandled === 0,
    ).toBe(true);
  });

  it("rejects loose Date.parse-compatible timestamps that are not strict ISO 8601", () => {
    // Regression guard: `Date.parse` accepts values like a bare integer or
    // `Date.toString()` output with parenthesized text. Treating those as
    // valid timestamps would (a) leak the raw string into the JSON report
    // and (b) mark malformed heartbeat text as healthy inbound evidence.
    for (const bad of [
      "42",
      "Wed May 28 2026 04:00:00 GMT+0000 (Coordinated Universal Time)",
      "2026/05/28 04:00:00",
      "not a date",
    ]) {
      const result = parseWhatsappHeartbeat(JSON.stringify({ lastInboundAt: bad }));
      expect(
        "heartbeat" in result && result.heartbeat.lastInboundAt,
        `expected ${JSON.stringify(bad)} to be rejected`,
      ).toBeNull();
    }
  });

  it("normalizes accepted timestamps to canonical ISO form", () => {
    const result = parseWhatsappHeartbeat(
      JSON.stringify({ lastInboundAt: "2026-05-28T03:59:30+00:00" }),
    );
    expect(
      "heartbeat" in result && result.heartbeat.lastInboundAt,
    ).toBe("2026-05-28T03:59:30.000Z");
  });

  it("returns parseError when the heartbeat is not an object", () => {
    const result = parseWhatsappHeartbeat("[]");
    expect(result).toEqual({ parseError: "heartbeat JSON must be an object" });
  });
});

describe("summarizeWhatsappLogLines", () => {
  it("returns deduped summary phrases, dropping unrelated lines", () => {
    const summaries = summarizeWhatsappLogLines([
      "2026-05-28 ws open",
      "2026-05-28 routine event",
      "2026-05-28 connection.open ack",
      "2026-05-28 unauthorized: 401",
      "2026-05-28 qr expired (retry)",
    ]);
    expect(summaries).toEqual(["connection.open", "401 unauthorized", "qr expired"]);
  });

  it("returns an empty list when nothing matches", () => {
    const summaries = summarizeWhatsappLogLines(["2026-05-28 normal traffic"]);
    expect(summaries).toEqual([]);
  });
});
