// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { MessagingHookContext, MessagingHookResult } from "../../../hooks/types";
import type { ChannelHealthReport } from "../../channel-health";
import { createWhatsappStatusHealthHook } from "./status-health";

const BASE_INPUTS = {
  currentSandbox: "alpha",
  agent: "openclaw",
  probedAt: "2026-07-14T00:00:00.000Z",
  channelEnabledInRegistry: true,
  presetInRegistry: true,
  presetOnGateway: true,
};

// A parseable phone number the redaction assertions treat as sentinel PII.
// The hook must never propagate it out of the sandbox JSON to the report.
const REDACTION_PHONE = "+14155551212";

function context(
  inputs: Record<string, unknown> = BASE_INPUTS,
  channelId = "whatsapp",
): MessagingHookContext {
  return {
    channelId,
    hookId: "whatsapp-status-health",
    phase: "status",
    inputs,
  } as unknown as MessagingHookContext;
}

type ExecResult = { status: number; stdout: string; stderr: string } | null;

function makeExec(result: ExecResult) {
  return vi.fn((_sandbox: string, _command: string, _timeout: number): ExecResult => result);
}

// Sequential mock: each invocation of the hook only issues one exec call, but
// some tests want to exercise multiple hook invocations against a scripted
// list of responses.
function makeSequentialExec(results: readonly ExecResult[]) {
  let call = 0;
  return vi.fn((_sandbox: string, _command: string, _timeout: number): ExecResult => {
    const value = results[call] ?? results[results.length - 1] ?? null;
    call += 1;
    return value;
  });
}

function reportOf(
  result: MessagingHookResult | Promise<MessagingHookResult>,
): ChannelHealthReport | undefined {
  const value = (result as MessagingHookResult).outputs?.channelHealth?.value as unknown as
    | { report?: ChannelHealthReport }
    | undefined;
  return value?.report;
}

function outputsOf(result: MessagingHookResult | Promise<MessagingHookResult>) {
  return (result as MessagingHookResult).outputs;
}

function stringifyReport(result: MessagingHookResult | Promise<MessagingHookResult>): string {
  return JSON.stringify(reportOf(result));
}

// Canonical stdout builder for the openclaw CLI. The runtime `wa` object
// carries redaction-sensitive `self.*` and `lastError` keys so tests can
// assert none of that leaks into the diagnostic.
type WaFixture = {
  readonly configured?: boolean;
  readonly statusState?: string;
  readonly linked?: boolean;
  readonly running?: boolean;
  readonly connected?: boolean;
  readonly healthState?: string;
  readonly lastInboundAt?: number | null;
  readonly lastStopAt?: number | null;
  readonly reconnectAttempts?: number;
  readonly self?: Record<string, string>;
  readonly lastError?: string | null;
};

function openclawPayload(wa: Record<string, unknown> | null): Record<string, unknown> {
  return {
    channels: {
      whatsapp: wa === null ? { configured: false } : { configured: wa.configured ?? false },
    },
    channelAccounts: {
      whatsapp: wa === null ? [] : [{ ...wa, accountId: "default" }],
    },
    channelDefaultAccountId: { whatsapp: "default" },
    ...(wa === null ? { error: "unknown channel: whatsapp" } : {}),
  };
}

function openclawJson(wa: Record<string, unknown> | null): string {
  return JSON.stringify(openclawPayload(wa));
}

const HEALTHY_WA: WaFixture = {
  configured: true,
  statusState: "linked",
  linked: true,
  running: true,
  connected: true,
  healthState: "healthy",
  lastInboundAt: Date.parse("2026-07-13T23:59:30.000Z"),
  reconnectAttempts: 0,
  self: { e164: REDACTION_PHONE, jid: `${REDACTION_PHONE}@s.whatsapp.net`, lid: "1@lid" },
  lastError: null,
};

// The exact PRA-1 / CR3 shape: the bridge went from linked+running to
// linked+stopped. `lastInboundAt` is still recent (last delivered message
// before the stop) but every liveness bit says "not running". This must not
// render as healthy.
const STOPPED_WA: WaFixture = {
  configured: true,
  statusState: "linked",
  linked: true,
  running: false,
  connected: false,
  healthState: "stopped",
  lastInboundAt: Date.parse("2026-07-13T23:59:30.000Z"),
  lastStopAt: Date.parse("2026-07-13T23:59:45.000Z"),
  reconnectAttempts: 0,
  self: { e164: REDACTION_PHONE, jid: `${REDACTION_PHONE}@s.whatsapp.net`, lid: "1@lid" },
  lastError: `disconnect from ${REDACTION_PHONE}`,
};

const UNPAIRED_WA: WaFixture = {
  configured: true,
  statusState: "unpaired",
  linked: false,
  running: false,
  connected: false,
  healthState: "stopped",
  lastInboundAt: null,
  reconnectAttempts: 0,
};

describe("whatsapp.statusHealth openclaw CLI probe", () => {
  it.each([
    // Verdict, wa fixture, and a short label. Table-driven so branching is
    // pushed into it.each iteration rather than test-body control flow.
    {
      label: "healthy: linked+running+connected+recent inbound",
      wa: HEALTHY_WA,
      verdict: "healthy",
    },
    {
      label: "stopped: linked+lastInboundAt fresh BUT running=false (PRA-1 / CR3 regression)",
      wa: STOPPED_WA,
      verdict: "idle",
    },
    { label: "unpaired: linked=false", wa: UNPAIRED_WA, verdict: "unpaired" },
  ] as const)("reports verdict $verdict for $label", ({ wa, verdict }) => {
    const exec = makeExec({ status: 0, stdout: openclawJson(wa), stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(reportOf(result)?.verdict).toBe(verdict);
    // The healthy path is the only case that must produce `healthy` — every
    // non-healthy fixture must render as something else so the PRA-1 root
    // cause (false-positive healthy on stopped) cannot regress.
    expect(reportOf(result)?.verdict === "healthy").toBe(verdict === "healthy");
  });

  it("stopped bridge never emits verdict=healthy (PRA-1 explicit guard)", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(STOPPED_WA), stderr: "" });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).not.toBe("healthy");
    const bridge = report?.signals.find((s) => s.label === "Bridge process");
    expect(bridge?.severity).toBe("fail");
  });

  it.each([
    // Redaction guard: none of these known-PII bytes may appear in the
    // emitted JSON, regardless of whether the fixture is healthy or stopped.
    { fixture: HEALTHY_WA, label: "healthy" },
    { fixture: STOPPED_WA, label: "stopped" },
  ])("never propagates self.* or lastError values ($label)", ({ fixture }) => {
    const exec = makeExec({ status: 0, stdout: openclawJson(fixture), stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const serialized = stringifyReport(result);
    expect(serialized).not.toContain(REDACTION_PHONE);
    expect(serialized).not.toContain("@s.whatsapp.net");
    expect(serialized).not.toContain("@lid");
    expect(serialized).not.toContain("disconnect from");
  });

  it("maps an unrecognized healthState to a fixed token so free text cannot leak", () => {
    // healthState is external JSON text; a compromised gateway could stuff PII
    // into it. Only the documented enum may be surfaced verbatim.
    const wa: WaFixture = { ...HEALTHY_WA, healthState: `leaked ${REDACTION_PHONE}` };
    const exec = makeExec({ status: 0, stdout: openclawJson(wa), stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const serialized = stringifyReport(result);
    expect(serialized).not.toContain(REDACTION_PHONE);
    expect(serialized).toContain("healthState=unknown");
  });

  it("reports unknown for the bounded unconfigured response with no channel state", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(null), stderr: "" });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).not.toBe("healthy");
    // paired stays null here, so the evaluator lands on "unknown" —
    // an honest "the gateway did not report whatsapp" rather than a fabricated
    // healthy. openclawJson(null) carries `error: "unknown channel: …"`.
    expect(report?.verdict).toBe("unknown");
    const logSignal = report?.signals.find((s) => s.label === "Recent log signals");
    expect(logSignal?.detail).toMatch(/not configured on the gateway/);
  });

  it("accepts the canonical successful payload without the failure-only reachability field", () => {
    const payload = {
      channels: { whatsapp: { configured: true } },
      channelAccounts: {
        whatsapp: [{ ...HEALTHY_WA, accountId: "default" }],
      },
      channelDefaultAccountId: { whatsapp: "default" },
    };
    const exec = makeExec({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).toBe("healthy");
  });

  it("selects the declared default account instead of trusting account-array order", () => {
    const payload = {
      // Keep the summary deliberately unpaired so this test also proves the
      // probe consumes authoritative per-account state rather than the summary.
      channels: { whatsapp: UNPAIRED_WA },
      channelAccounts: {
        whatsapp: [
          { ...UNPAIRED_WA, accountId: "secondary" },
          { ...HEALTHY_WA, accountId: "default" },
        ],
      },
      channelDefaultAccountId: { whatsapp: "default" },
    };
    const exec = makeExec({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).toBe("healthy");
  });

  it.each([
    {
      label: "stale healthy channel state",
      payload: {
        gatewayReachable: false,
        configOnly: true,
        channels: { whatsapp: HEALTHY_WA },
      },
    },
    {
      label: "unknown-channel error without channel state",
      payload: {
        gatewayReachable: false,
        error: "unknown channel: whatsapp",
        configOnly: true,
      },
    },
    {
      label: "misleading unknown-channel error with populated channel state",
      payload: {
        gatewayReachable: false,
        error: "unknown channel: whatsapp",
        configOnly: true,
        channels: { whatsapp: UNPAIRED_WA },
      },
    },
    {
      label: "unknown-channel error for a different channel",
      payload: {
        gatewayReachable: false,
        error: "unknown channel: telegram",
        configOnly: true,
      },
    },
    {
      label: "embellished unknown-channel error text",
      payload: {
        gatewayReachable: false,
        error: "prefix unknown channel: whatsapp",
        configOnly: true,
      },
    },
  ])("fails closed when the gateway is unreachable despite $label", ({ payload }) => {
    const exec = makeExec({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).toBe("probe_failed");
    expect(report?.signals.some((signal) => signal.label === "Recent log signals")).toBe(false);
  });

  it.each([
    {
      label: "both gatewayReachable and the canonical channels map are absent",
      payload: {},
    },
    {
      label: "gatewayReachable is non-boolean",
      payload: { ...openclawPayload(HEALTHY_WA), gatewayReachable: "true" },
    },
    {
      label: "summary-only payload has no authoritative account state",
      payload: { channels: { whatsapp: HEALTHY_WA } },
    },
    {
      label: "linked is absent",
      payload: openclawPayload({ ...HEALTHY_WA, linked: undefined }),
    },
    {
      label: "linked is non-boolean",
      payload: openclawPayload({ ...HEALTHY_WA, linked: "true" }),
    },
    {
      label: "running is absent",
      payload: openclawPayload({ ...HEALTHY_WA, running: undefined }),
    },
    {
      label: "running is non-boolean",
      payload: openclawPayload({ ...HEALTHY_WA, running: 1 }),
    },
    {
      label: "connected is absent",
      payload: openclawPayload({ ...HEALTHY_WA, connected: undefined }),
    },
    {
      label: "connected is non-boolean",
      payload: openclawPayload({ ...HEALTHY_WA, connected: "yes" }),
    },
    {
      label: "default account id does not identify exactly one account",
      payload: {
        channels: { whatsapp: HEALTHY_WA },
        channelAccounts: {
          whatsapp: [{ ...HEALTHY_WA, accountId: "secondary" }],
        },
        channelDefaultAccountId: { whatsapp: "default" },
      },
    },
    {
      label: "per-account state is not an array",
      payload: {
        channels: { whatsapp: HEALTHY_WA },
        channelAccounts: { whatsapp: HEALTHY_WA },
        channelDefaultAccountId: { whatsapp: "default" },
      },
    },
  ])("fails closed when the live-status contract is invalid: $label (#7016)", ({ payload }) => {
    const exec = makeExec({ status: 0, stdout: JSON.stringify(payload), stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    const report = reportOf(result);
    expect(report?.verdict).toBe("probe_failed");
    expect(stringifyReport(result)).not.toContain("channel runtime reports WhatsApp is not paired");
    expect(stringifyReport(result)).not.toContain("no bridge process");
  });

  it("degrades an out-of-range lastInboundAt to null instead of crashing", () => {
    // A finite-but-out-of-Date-range epoch (e.g. 1e300) passes Number.isFinite
    // yet makes `new Date(v).toISOString()` throw RangeError. The probe must
    // degrade it to null, not crash the whole status command.
    const exec = makeExec({
      status: 0,
      stdout: openclawJson({ ...HEALTHY_WA, lastInboundAt: 1e300 }),
      stderr: "",
    });
    const run = () => createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context());
    expect(run).not.toThrow();
    expect(reportOf(run())?.verdict).toBeDefined();
  });

  it("no-ops for Hermes because the live status contract is OpenClaw-only", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(HEALTHY_WA), stderr: "" });
    const result = createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(
      context({ ...BASE_INPUTS, agent: "hermes" }),
    );
    expect(outputsOf(result)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "non-zero exec",
      exec: { status: 124, stdout: openclawJson(HEALTHY_WA), stderr: "timed out" },
    },
    { label: "null exec (sandbox down)", exec: null as ExecResult },
    { label: "empty stdout", exec: { status: 0, stdout: "", stderr: "" } },
    { label: "non-JSON stdout", exec: { status: 0, stdout: "not json at all", stderr: "" } },
    {
      label: "arbitrary stdout preamble before valid JSON",
      exec: {
        status: 0,
        stdout: `warning: untrusted preamble\n${openclawJson(HEALTHY_WA)}`,
        stderr: "",
      },
    },
    { label: "JSON but not an object", exec: { status: 0, stdout: '"hello"', stderr: "" } },
  ] as const)("verdict=probe_failed when $label", ({ exec }) => {
    const runner = makeExec(exec);
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: runner })(context()),
    );
    expect(report?.verdict).toBe("probe_failed");
  });

  it("reports probe_failed when the sandbox exec runner throws", () => {
    const exec = vi.fn(() => {
      throw new Error("sandbox exec unavailable");
    });
    const report = reportOf(
      createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(context()),
    );
    expect(report?.verdict).toBe("probe_failed");
  });

  it("invokes the openclaw CLI with the JSON + timeout flags", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(HEALTHY_WA), stderr: "" });
    createWhatsappStatusHealthHook({ executeSandboxCommand: exec, timeoutMs: 4500 })(context());
    const command = String(exec.mock.calls[0]?.[1] ?? "");
    expect(command).toContain("openclaw channels status --channel whatsapp --json");
    expect(command).toContain("--timeout 4500");
    // The hook must not fall back to the old log-scraping / pgrep / dir-listing
    // probe: the new implementation never issues those commands.
    expect(command).not.toContain("/tmp/gateway.log");
    expect(command).not.toMatch(/pgrep/);
    expect(command).not.toMatch(/DIR .* POPULATED/);
  });

  it("healthState surfaces neutral state signal only when non-healthy", () => {
    const stale: WaFixture = {
      ...HEALTHY_WA,
      healthState: "stale",
      reconnectAttempts: 3,
      connected: false,
    };
    const exec = makeSequentialExec([
      { status: 0, stdout: openclawJson(HEALTHY_WA), stderr: "" },
      { status: 0, stdout: openclawJson(stale), stderr: "" },
    ]);
    const hook = createWhatsappStatusHealthHook({ executeSandboxCommand: exec });
    const healthyReport = reportOf(hook(context()));
    // Healthy runs stay clean (no "Recent log signals" row from healthState).
    expect(healthyReport?.signals.some((s) => s.label === "Recent log signals")).toBe(false);
    const staleReport = reportOf(hook(context()));
    const staleLogs = staleReport?.signals.find((s) => s.label === "Recent log signals");
    expect(staleLogs?.detail).toMatch(/healthState=stale/);
    expect(staleLogs?.detail).toMatch(/reconnectAttempts=3/);
  });
});

describe("whatsapp.statusHealth wiring guards", () => {
  it("no-ops for a non-whatsapp channel or without an exec runner", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(HEALTHY_WA), stderr: "" });
    expect(
      outputsOf(
        createWhatsappStatusHealthHook({ executeSandboxCommand: exec })(
          context(BASE_INPUTS, "slack"),
        ),
      ),
    ).toBeUndefined();
    expect(outputsOf(createWhatsappStatusHealthHook({})(context()))).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("derives config_gap / policy_gap from the host-fact inputs", () => {
    const exec = makeExec({ status: 0, stdout: openclawJson(HEALTHY_WA), stderr: "" });
    const hook = createWhatsappStatusHealthHook({ executeSandboxCommand: exec });
    const configGap = reportOf(hook(context({ ...BASE_INPUTS, channelEnabledInRegistry: false })));
    expect(configGap?.verdict).toBe("config_gap");
    const policyGap = reportOf(hook(context({ ...BASE_INPUTS, presetInRegistry: false })));
    expect(policyGap?.verdict).toBe("policy_gap");
  });
});
