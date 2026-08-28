// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSession,
  filterSafeUpdates,
  normalizeSession,
  summarizeForDebug,
} from "./onboard-session";

type LegacySession = Omit<ReturnType<typeof createSession>, "machine"> & {
  machine?: unknown;
};

function requireNormalizedSession(legacy: LegacySession) {
  const normalized = normalizeSession(legacy as Parameters<typeof normalizeSession>[0]);
  expect(normalized).not.toBeNull();
  return normalized!;
}

describe("onboard session normalization", () => {
  it("preserves valid recovery-only cancellation state (#9833)", () => {
    const cancellationRecovery = {
      reason: "cancelled_after_sandbox_creation" as const,
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "a".repeat(64),
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    const normalized = normalizeSession({
      ...createSession({ sandboxName: "retained-sb" }),
      resumable: false,
      status: "recovery_required",
      cancellationRecovery,
    });

    expect(normalized).toMatchObject({
      sandboxName: "retained-sb",
      resumable: false,
      status: "recovery_required",
      cancellationRecovery,
    });
    expect(summarizeForDebug(normalized)?.cancellationRecovery).toEqual(cancellationRecovery);
  });

  it("keeps APF create intent and defaults legacy sessions to false (#9833)", () => {
    const selected = createSession({ apfInterceptorRequested: true });
    expect(normalizeSession(selected)?.apfInterceptorRequested).toBe(true);

    const legacy = { ...selected } as Partial<typeof selected>;
    delete legacy.apfInterceptorRequested;
    expect(
      normalizeSession(legacy as Parameters<typeof normalizeSession>[0])?.apfInterceptorRequested,
    ).toBe(false);
    expect(
      normalizeSession({ ...selected, apfInterceptorRequested: false })?.apfInterceptorRequested,
    ).toBe(false);
  });

  it("refuses malformed saved APF create intent instead of downgrading it (#9833)", () => {
    const selected = createSession({ apfInterceptorRequested: true });
    const malformed = { ...selected, apfInterceptorRequested: "true" };

    expect(() =>
      normalizeSession(malformed as unknown as Parameters<typeof normalizeSession>[0]),
    ).toThrow(/saved APF selection is invalid/u);
  });

  it("keeps recognized, absent, and legacy null policy authority values (#9833)", () => {
    const external = createSession({ policyAuthority: "externally-managed" });
    expect(normalizeSession(external)?.policyAuthority).toBe("externally-managed");

    const absent = { ...external } as Partial<typeof external>;
    delete absent.policyAuthority;
    expect(
      normalizeSession(absent as Parameters<typeof normalizeSession>[0])?.policyAuthority,
    ).toBeNull();
    expect(normalizeSession({ ...external, policyAuthority: null })?.policyAuthority).toBeNull();
  });

  it("refuses an invalid saved policy authority (#9833)", () => {
    const external = createSession({ policyAuthority: "externally-managed" });
    const malformed = { ...external, policyAuthority: "unspecified" };
    expect(() => normalizeSession(malformed as Parameters<typeof normalizeSession>[0])).toThrow(
      /saved policy authority is invalid/u,
    );
  });

  it("clears NemoClaw preset attribution for external policy authority (#9833)", () => {
    const external = createSession({
      policyAuthority: "externally-managed",
      policyPresets: ["npm"],
    });
    expect(external.policyPresets).toBeNull();

    const legacy = {
      ...createSession({ policyAuthority: "nemoclaw-managed", policyPresets: ["npm"] }),
      policyAuthority: "externally-managed" as const,
    };
    expect(normalizeSession(legacy)?.policyPresets).toBeNull();
    expect(
      filterSafeUpdates({ policyAuthority: "externally-managed", policyPresets: ["npm"] }),
    ).toMatchObject({ policyAuthority: "externally-managed", policyPresets: null });
  });

  it("normalizes old sessions without machine snapshots", () => {
    const legacy = createSession({
      sessionId: "legacy-session",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    }) as unknown as LegacySession;
    delete legacy.machine;
    legacy.steps.gateway.status = "in_progress";
    legacy.steps.gateway.startedAt = "2026-01-01T00:02:00.000Z";
    legacy.lastStepStarted = "gateway";

    let normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "gateway",
      stateEnteredAt: "2026-01-01T00:02:00.000Z",
      revision: 0,
    });

    legacy.steps.gateway.status = "complete";
    legacy.steps.gateway.completedAt = "2026-01-01T00:03:00.000Z";
    legacy.lastCompletedStep = "gateway";
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "provider_selection",
      stateEnteredAt: "2026-01-01T00:03:00.000Z",
      revision: 0,
    });

    legacy.status = "failed";
    legacy.failure = {
      step: "gateway",
      message: "boom",
      recordedAt: "2026-01-01T00:04:00.000Z",
    };
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "failed",
      stateEnteredAt: "2026-01-01T00:04:00.000Z",
      revision: 0,
    });

    legacy.status = "complete";
    normalized = requireNormalizedSession(legacy);
    expect(normalized.machine.state).toBe("complete");
  });

  it("normalizes invalid machine snapshots from old sessions", () => {
    const legacy = createSession({
      lastCompletedStep: "policies",
    }) as unknown as LegacySession;
    legacy.steps.policies.status = "complete";
    legacy.steps.policies.completedAt = "2026-01-01T00:08:00.000Z";
    legacy.machine = {
      version: 1,
      state: "not-a-state",
      stateEnteredAt: "2026-01-01T00:09:00.000Z",
      revision: -1,
    };

    const normalized = requireNormalizedSession(legacy);
    expect(normalized.machine).toEqual({
      version: 1,
      state: "finalizing",
      stateEnteredAt: "2026-01-01T00:08:00.000Z",
      revision: 0,
    });
  });
});
