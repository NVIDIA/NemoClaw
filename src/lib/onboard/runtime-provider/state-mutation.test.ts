// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { prepareRuntimeProviderStateMutationPlan } from "./state-mutation";

const PROJECTION_SHA256 = "a".repeat(64);

function plan() {
  return {
    schemaVersion: 1,
    intent: "restore",
    stateRoot: "/sandbox/.hermes",
    selectors: [
      { kind: "path", path: "scripts" },
      { kind: "path", path: "cron" },
      { kind: "prefix", prefix: "workspace-" },
    ],
    projectionSha256: PROJECTION_SHA256,
  };
}

describe("runtime provider state-mutation plan", () => {
  it("binds a bounded scope to the AgentDefinition projection without copying it (#7744)", () => {
    const source = plan();
    const prepared = prepareRuntimeProviderStateMutationPlan(source);

    expect(prepared.plan).toEqual(source);
    expect(prepared.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.projectionSha256).toBe(PROJECTION_SHA256);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.plan)).toBe(true);
    expect(Object.isFrozen(prepared.plan.selectors)).toBe(true);
    expect(Object.isFrozen(prepared.plan.selectors[0])).toBe(true);
    expect(prepared.plan).not.toBe(source);
  });

  it("keeps the plan digest sensitive to intent, scope, and projection authority (#7744)", () => {
    const restore = prepareRuntimeProviderStateMutationPlan(plan());
    const protectionTransition = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      intent: "protection-transition",
    });
    const changedProjection = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      projectionSha256: "b".repeat(64),
    });

    expect(protectionTransition.planSha256).not.toBe(restore.planSha256);
    expect(changedProjection.planSha256).not.toBe(restore.planSha256);
    expect(changedProjection.projectionSha256).toBe("b".repeat(64));
  });

  it("rejects accessor-backed values before validation can drift (#7744)", () => {
    const accessorPlan = plan();
    Object.defineProperty(accessorPlan, "projectionSha256", {
      enumerable: true,
      get: () => PROJECTION_SHA256,
    });
    expect(() => prepareRuntimeProviderStateMutationPlan(accessorPlan)).toThrow(
      /fixed data properties/u,
    );

    const accessorSelectors = plan();
    Object.defineProperty(accessorSelectors.selectors, "0", {
      enumerable: true,
      get: () => ({ kind: "path", path: "scripts" }),
    });
    expect(() => prepareRuntimeProviderStateMutationPlan(accessorSelectors)).toThrow(
      /fixed data properties/u,
    );
  });

  it.each([
    ["a callback", () => ({ ...plan(), callback: () => undefined })],
    ["a command", () => ({ ...plan(), command: ["sh", "-c", "true"] })],
    [
      "an unknown selector field",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "scripts", source: "/tmp/staged" }],
      }),
    ],
  ])("rejects %s instead of expanding the declarative boundary (#7744)", (_label, value) => {
    expect(() => prepareRuntimeProviderStateMutationPlan(value())).toThrow(
      /fields are unsupported/u,
    );
  });

  it.each([
    ["relative state root", () => ({ ...plan(), stateRoot: "sandbox/.hermes" })],
    ["filesystem root", () => ({ ...plan(), stateRoot: "/" })],
    ["system state root", () => ({ ...plan(), stateRoot: "/etc/nemoclaw" })],
    ["state-root traversal", () => ({ ...plan(), stateRoot: "/sandbox/../etc" })],
    [
      "relative-path traversal",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "scripts/../../etc" }],
      }),
    ],
    [
      "control characters",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "scripts\u0000escape" }],
      }),
    ],
    [
      "uppercase projection digest",
      () => ({
        ...plan(),
        projectionSha256: "A".repeat(64),
      }),
    ],
  ])("rejects %s (#7744)", (_label, value) => {
    expect(() => prepareRuntimeProviderStateMutationPlan(value())).toThrow(
      /state-mutation plan is invalid/u,
    );
  });

  it("rejects duplicate and oversized selector sets (#7744)", () => {
    expect(() => prepareRuntimeProviderStateMutationPlan({ ...plan(), selectors: [] })).toThrow(
      /non-empty bounded array/u,
    );

    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...plan(),
        selectors: [
          { kind: "path", path: "scripts" },
          { kind: "path", path: "scripts" },
        ],
      }),
    ).toThrow(/must not repeat/u);

    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...plan(),
        selectors: Array.from({ length: 257 }, (_, index) => ({
          kind: "path",
          path: `state-${String(index)}`,
        })),
      }),
    ).toThrow(/bounded array/u);

    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...plan(),
        selectors: Array.from({ length: 256 }, (_, index) => ({
          kind: "path",
          path: `${String(index)}-${"a".repeat(300)}`,
        })),
      }),
    ).toThrow(/bounded transport/u);
  });
});
