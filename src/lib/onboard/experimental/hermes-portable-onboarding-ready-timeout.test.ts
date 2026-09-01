// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_LIVE_IDENTITY,
  HERMES_PORTABLE_TEST_POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";

let stateDir: string;
let policyPath: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-ready-timeout-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

describe("Hermes portable onboarding readiness timeout", () => {
  it("uses the configured timeout to settle identity after the old Ready deadline (#9211)", async () => {
    const currentInput = {
      ...createHermesPortableTestInput(stateDir, policyPath),
      sandboxReadyTimeoutSecs: 90,
    };
    const present = {
      kind: "present" as const,
      sandboxId: "sandbox-id-1",
      liveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
    };
    let nowMs = 0;
    let classificationObservations = 0;
    const boundedBudgets: Array<{ budgetMs: number; remainingMs: number }> = [];
    const observeSandbox = vi.fn((timeoutBudgetMs?: number) => {
      const budgetMs = timeoutBudgetMs ?? 0;
      const classification = timeoutBudgetMs === undefined;
      classificationObservations += Number(classification);
      boundedBudgets.push({ budgetMs, remainingMs: 90_000 - nowMs });
      const observed = classification
        ? classificationObservations <= 2
          ? { kind: "absent" as const }
          : present
        : nowMs >= 61_000
          ? present
          : { kind: "ambiguous" as const, detail: "exact OpenShell sandbox is not Ready" };
      nowMs += classification ? 0 : Math.min(budgetMs, Math.max(0, 61_000 - nowMs));
      return observed;
    });
    const delaySandboxReadyPublicationPoll = async (milliseconds: number) => {
      nowMs += milliseconds;
    };
    const fixture = createHermesPortableTransactionFixture(currentInput, {
      observeSandbox,
      delaySandboxReadyPublicationPoll,
      readSandboxReadyPublicationClockMs: () => nowMs,
    });

    const completed = await runHermesPortableOnboardingTransaction(currentInput, fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(completed.created).toBe(true);
    expect(fixture.events.filter((event) => event === "create")).toHaveLength(1);
    expect(classificationObservations).toBeGreaterThan(0);
    expect(nowMs).toBeGreaterThan(60_000);
    expect(boundedBudgets.length).toBeGreaterThan(0);
    expect(boundedBudgets.find(({ budgetMs }) => budgetMs > 0)?.budgetMs).toBe(90_000);
    expect(boundedBudgets.every(({ budgetMs, remainingMs }) => budgetMs <= remainingMs)).toBe(true);
    expect(fixture.events[0]).toBe("lock-enter");
    expect(fixture.events.at(-1)).toBe("lock-exit");
  });
});
