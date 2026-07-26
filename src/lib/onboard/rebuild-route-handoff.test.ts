// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  createProviderRecoveryReceiptLedger,
  createRebuildRouteHandoff,
  mintProviderRecoveryReceipt,
  type ProviderRecoveryReceiptTarget,
  type RegistryInferenceRoute,
} from "./rebuild-route-handoff";

function registryRoute(): RegistryInferenceRoute {
  return {
    provider: "compatible-endpoint",
    model: "nvidia/model",
    endpointUrl: "https://inference.example.test/v1",
    endpointSource: "onboard",
    preferredInferenceApi: "openai-completions",
    source: "registry",
  };
}

function receiptTarget(
  overrides: Partial<ProviderRecoveryReceiptTarget> = {},
): ProviderRecoveryReceiptTarget {
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw",
    provider: "compatible-endpoint",
    model: "nvidia/model",
    route: registryRoute(),
    ...overrides,
  };
}

describe("createRebuildRouteHandoff", () => {
  it("defensively copies and freezes the complete registry route", () => {
    const route = registryRoute();
    const handoff = createRebuildRouteHandoff("alpha", route);

    expect(handoff).toEqual({ sandboxName: "alpha", route });
    expect(handoff.route).not.toBe(route);
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.route)).toBe(true);
    expect(Reflect.set(handoff, "sandboxName", "other")).toBe(false);
    expect(Reflect.set(handoff.route, "provider", "attacker")).toBe(false);
    expect(handoff).toEqual({ sandboxName: "alpha", route });
    expectTypeOf(handoff.route.source).toEqualTypeOf<"registry">();
  });

  it("rejects an untyped session route before it can become registry authority", () => {
    const sessionRoute = {
      ...registryRoute(),
      source: "session",
    } as unknown as RegistryInferenceRoute;

    expect(() => createRebuildRouteHandoff("alpha", sessionRoute)).toThrow(
      "Rebuild route handoff requires a registry-derived route",
    );
  });
});

describe("mintProviderRecoveryReceipt", () => {
  it("binds the target and freezes the route with an unbound session", () => {
    const target = receiptTarget();
    const receipt = mintProviderRecoveryReceipt(target, { nonce: "n1", expiresAtMs: 1_000 });

    expect(receipt).toEqual({ ...target, nonce: "n1", expiresAtMs: 1_000, sessionId: null });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.route)).toBe(true);
    expect(receipt.route).not.toBe(target.route);
  });

  it("rejects incomplete targets and a non-registry route", () => {
    expect(() =>
      mintProviderRecoveryReceipt(receiptTarget({ sandboxName: "  " }), {
        nonce: "n1",
        expiresAtMs: 1_000,
      }),
    ).toThrow("Provider recovery receipt is incomplete");
    expect(() =>
      mintProviderRecoveryReceipt(receiptTarget(), { nonce: "", expiresAtMs: 1_000 }),
    ).toThrow("Provider recovery receipt is incomplete");
    const sessionRoute = {
      ...registryRoute(),
      source: "session",
    } as unknown as RegistryInferenceRoute;
    expect(() =>
      mintProviderRecoveryReceipt(receiptTarget({ route: sessionRoute }), {
        nonce: "n1",
        expiresAtMs: 1_000,
      }),
    ).toThrow("Provider recovery receipt requires a registry-derived route");
  });
});

describe("createProviderRecoveryReceiptLedger", () => {
  const mint = (overrides: Partial<ProviderRecoveryReceiptTarget> = {}, nonce = "n1") =>
    mintProviderRecoveryReceipt(receiptTarget(overrides), { nonce, expiresAtMs: 1_000 });

  it("activates a matching receipt and binds it to the session", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    const activated = ledger.activate(mint(), {
      target: receiptTarget(),
      sessionId: "sess-a",
      nowMs: 500,
    });

    expect(activated?.sessionId).toBe("sess-a");
  });

  it("refuses a replayed activation under a different session (one-shot)", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    const receipt = mint();
    expect(
      ledger.activate(receipt, { target: receiptTarget(), sessionId: "sess-a", nowMs: 500 }),
    ).not.toBeNull();
    expect(
      ledger.activate(receipt, { target: receiptTarget(), sessionId: "sess-b", nowMs: 500 }),
    ).toBeNull();
  });

  it("refuses a replayed activation under the same session (one-shot)", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    const receipt = mint();
    const context = { target: receiptTarget(), sessionId: "sess-a", nowMs: 500 };

    expect(ledger.activate(receipt, context)).not.toBeNull();
    expect(ledger.activate(receipt, context)).toBeNull();
  });

  it("refuses activation for an expired, cross-sandbox, or mismatched-route target", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    expect(
      ledger.activate(mint({}, "expired"), {
        target: receiptTarget(),
        sessionId: "sess-a",
        nowMs: 2_000,
      }),
    ).toBeNull();
    expect(
      ledger.activate(mint({}, "cross"), {
        target: receiptTarget({ sandboxName: "beta" }),
        sessionId: "sess-a",
        nowMs: 500,
      }),
    ).toBeNull();
    expect(
      ledger.activate(mint({}, "route"), {
        target: receiptTarget({ route: { ...registryRoute(), model: "other/model" } }),
        sessionId: "sess-a",
        nowMs: 500,
      }),
    ).toBeNull();
    expect(
      ledger.activate(mint({}, "api"), {
        target: receiptTarget({
          route: { ...registryRoute(), preferredInferenceApi: "openai-responses" },
        }),
        sessionId: "sess-a",
        nowMs: 500,
      }),
    ).toBeNull();
    expect(
      ledger.activate(null, { target: receiptTarget(), sessionId: "sess-a", nowMs: 500 }),
    ).toBeNull();
  });

  it("passes an in-lock recheck only for the owning session with a held reservation", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    const receipt = mint();
    ledger.activate(receipt, { target: receiptTarget(), sessionId: "sess-a", nowMs: 500 });
    const activated = { ...receipt, sessionId: "sess-a" };
    const base = {
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      sessionId: "sess-a",
      nowMs: 500,
      reservationOwned: true,
    };

    expect(ledger.validateInLock(activated, base)).toBe(true);
    expect(ledger.validateInLock(activated, { ...base, reservationOwned: false })).toBe(false);
    expect(ledger.validateInLock(activated, { ...base, sessionId: "sess-b" })).toBe(false);
    expect(ledger.validateInLock(activated, { ...base, sandboxName: "beta" })).toBe(false);
    expect(ledger.validateInLock(activated, { ...base, nowMs: 2_000 })).toBe(false);
    expect(ledger.validateInLock({ ...activated, sessionId: null }, base)).toBe(false);
  });

  it("rejects an in-lock recheck for a receipt that was never activated", () => {
    const ledger = createProviderRecoveryReceiptLedger();
    const receipt = { ...mint(), sessionId: "sess-a" };

    expect(
      ledger.validateInLock(receipt, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        sessionId: "sess-a",
        nowMs: 500,
        reservationOwned: true,
      }),
    ).toBe(false);
  });
});
