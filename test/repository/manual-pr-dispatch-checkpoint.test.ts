// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readCheckpoint, resumeCheckpoint } from "../../tools/task-continuation/checkpoint.mts";
import {
  manualPrDispatchFixture,
  manualPrProcedures,
  cleanupManualPrDispatchFixtures,
} from "../support/manual-pr-dispatch-fixture.ts";

const { candidate, headResult, base, baseResult } = manualPrProcedures;
afterEach(cleanupManualPrDispatchFixtures);

describe.skipIf(process.platform === "win32")("manual PR dispatch recovery", () => {
  it("rejects an authorized base selector that differs from the candidate before consuming its budget", () => {
    const { file, service, env, run } = manualPrDispatchFixture("different-authorized-target");
    const prepared = run(`${candidate}\n${headResult}`);
    expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
    const state = readCheckpoint(file);
    env.E2E_TARGETS = "different-authorized-target";
    const result = run(base);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Base selectors differ");
    expect(readCheckpoint(file)).toEqual(state);
    expect(resumeCheckpoint(file).usage["base-comparison"]).toBe(0);
    expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(1);
  }, 30000);

  it.each([
    {
      phase: "candidate",
      prepare: "",
      dispatch: candidate,
      count: 0,
      field: "E2E_TARGETS" as const,
      value: "unauthorized-target",
    },
    {
      phase: "candidate",
      prepare: "",
      dispatch: candidate,
      count: 0,
      field: "INCLUDE_STAGING_BREV_LAUNCHABLE" as const,
      value: "true",
    },
    {
      phase: "base",
      prepare: `${candidate}\n${headResult}`,
      dispatch: base,
      count: 1,
      field: "E2E_TARGETS" as const,
      value: "unauthorized-target",
    },
    {
      phase: "base",
      prepare: `${candidate}\n${headResult}`,
      dispatch: base,
      count: 1,
      field: "INCLUDE_STAGING_BREV_LAUNCHABLE" as const,
      value: "true",
    },
  ])(
    "rejects $phase $field mismatches before dispatch",
    ({ prepare, dispatch, count, field, value }) => {
      const { file, service, env, run } = manualPrDispatchFixture();
      const prepared = run(prepare);
      expect(prepared.status, prepared.stdout + prepared.stderr).toBe(0);
      const before = readCheckpoint(file);
      env[field] = value;
      const result = run(dispatch);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("differs from recorded authorization");
      expect(readCheckpoint(file)).toEqual(before);
      expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(count);
    },
    30000,
  );

  it("stops before dispatch when checkpoint functions have not been loaded", () => {
    const { file, service, env, runWithoutFunctions } = manualPrDispatchFixture();
    const result = runWithoutFunctions(candidate);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("save_dispatch_intent");
    expect(existsSync(env.FAKE_DISPATCHES)).toBe(false);
    expect(JSON.parse(readFileSync(service, "utf8"))).toEqual([]);
    expect(readCheckpoint(file).operations).toEqual([]);
  });

  it("persists candidate and base intent before dispatch and records each discovered run", () => {
    const { file, service, run } = manualPrDispatchFixture();
    const result = run(`${candidate}\n${headResult}\n${base}\n${baseResult}`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const checkpoint = readCheckpoint(file);
    expect(checkpoint.operations).toHaveLength(2);
    const contexts = checkpoint.operations.map((operation) => JSON.parse(operation.action));
    expect(contexts.map((context) => context.checkoutSha)).toEqual([
      "a".repeat(40),
      "b".repeat(40),
    ]);
    expect(contexts.map((context) => context.budgetKey)).toEqual([
      "candidate-dispatch",
      "base-comparison",
    ]);
    expect(
      contexts.every(
        (context) =>
          context.targets === "sandbox-operations" && context.cleanupOwner === "fixture-owner",
      ),
    ).toBe(true);
    expect(checkpoint.operations.map((operation) => operation.state)).toEqual([
      "observed",
      "observed",
    ]);
    expect(
      checkpoint.operations.map((operation) => JSON.parse(operation.observation).runId),
    ).toEqual(["100", "101"]);
    expect(checkpoint.identities).toMatchObject({
      "manualE2E.candidate.runId": "100",
      "manualE2E.base.runId": "101",
    });
    expect(resumeCheckpoint(file).usage).toEqual({ "candidate-dispatch": 1, "base-comparison": 1 });
    const exhausted = run(candidate);
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toContain("budget exhausted");
    expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(2);
    expect(readCheckpoint(file)).toEqual(checkpoint);
  }, 30000);

  it("retains correlation, budget, and cleanup ownership when interrupted after dispatch", () => {
    const { file, service, run } = manualPrDispatchFixture();
    const result = run(`${candidate}\nkill -KILL $$`);
    expect(result.signal, result.stdout + result.stderr).toBe("SIGKILL");
    const report = resumeCheckpoint(file);
    expect(report.resumeAction).toBe("reconcile-external-state");
    expect(report.pendingOperationIds).toHaveLength(1);
    expect(report.usage["candidate-dispatch"]).toBe(1);
    const context = JSON.parse(report.operations[0]!.action);
    expect(context).toMatchObject({
      phase: "candidate",
      checkoutSha: "a".repeat(40),
      budgetKey: "candidate-dispatch",
      cleanupOwner: "fixture-owner",
      cleanupObligation: "Remove fixture-owned resources",
    });
    const runs = JSON.parse(readFileSync(service, "utf8"));
    expect(runs).toHaveLength(1);
    expect(runs[0].displayTitle).toContain(context.correlationId);
    const duplicate = run(base);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("Reconcile pending");
    expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(1);
  }, 30000);

  it.each([
    { phase: "candidate", runId: "100", count: 1 },
    { phase: "base", runId: "101", count: 2 },
  ])(
    "bounds a stalled $phase watch and retains the observed run",
    ({ phase, runId, count }) => {
      const { file, service, env, run } = manualPrDispatchFixture();
      env.FAKE_STALL_WATCH_RUN = runId;
      env.E2E_WATCH_TIMEOUT_SECONDS = "0.5";
      const result = run(`${candidate}\n${headResult}\n${base}\n${baseResult}`);
      expect(result.status, result.stdout + result.stderr).toBe(124);
      expect(result.signal).toBeNull();
      expect(readFileSync(env.FAKE_WATCH_STARTED, "utf8")).toBe(runId);
      expect(result.stderr).toContain(`Observation timed out after 0.5s for ${runId}`);
      expect(result.stderr).toContain("do not dispatch again");
      expect(result.stderr).toContain("fixture-owner");
      expect(result.stderr).toContain("Remove fixture-owned resources");
      const checkpoint = readCheckpoint(file);
      expect(checkpoint.operations).toHaveLength(count);
      expect(checkpoint.operations.every((operation) => operation.state === "observed")).toBe(true);
      expect(checkpoint.identities[`manualE2E.${phase}.runId`]).toBe(runId);
      expect(JSON.parse(checkpoint.operations.at(-1)!.observation).runId).toBe(runId);
      expect(JSON.parse(checkpoint.operations.at(-1)!.action).cleanupObligation).toBe(
        "Remove fixture-owned resources",
      );
      expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(count);
      expect(run(candidate).status).not.toBe(0);
      expect(readCheckpoint(file)).toEqual(checkpoint);
      expect(JSON.parse(readFileSync(service, "utf8"))).toHaveLength(count);
    },
    30000,
  );
});
