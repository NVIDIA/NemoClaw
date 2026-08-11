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

describe("runtime provider state mutation plan", () => {
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
    const changedScope = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      selectors: [{ kind: "path", path: "scripts" }],
    });

    expect(protectionTransition.planSha256).not.toBe(restore.planSha256);
    expect(changedProjection.planSha256).not.toBe(restore.planSha256);
    expect(changedScope.planSha256).not.toBe(restore.planSha256);
    expect(changedProjection.projectionSha256).toBe("b".repeat(64));
  });

  it("does not let inherited JSON hooks change the digest or size limit (#7744)", () => {
    const baseline = prepareRuntimeProviderStateMutationPlan(plan());
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let pollutedDigest = "";
    let oversizedRejected = false;

    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => "polluted-object",
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ["polluted-array"],
      });

      pollutedDigest = prepareRuntimeProviderStateMutationPlan(plan()).planSha256;
      try {
        prepareRuntimeProviderStateMutationPlan({
          ...plan(),
          selectors: Array.from({ length: 256 }, (_, index) => ({
            kind: "path",
            path: `${String(index)}-${"a".repeat(300)}`,
          })),
        });
      } catch (error) {
        oversizedRejected =
          error instanceof Error &&
          /canonical plan exceeds its bounded transport/u.test(error.message);
      }
    } finally {
      objectToJson === undefined
        ? Reflect.deleteProperty(Object.prototype, "toJSON")
        : Object.defineProperty(Object.prototype, "toJSON", objectToJson);
      arrayToJson === undefined
        ? Reflect.deleteProperty(Array.prototype, "toJSON")
        : Object.defineProperty(Array.prototype, "toJSON", arrayToJson);
    }

    expect(pollutedDigest).toBe(baseline.planSha256);
    expect(oversizedRejected).toBe(true);
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
    [
      "relative state root",
      () => ({ ...plan(), stateRoot: "sandbox/.hermes" }),
      /canonical absolute path below \/sandbox/u,
    ],
    [
      "filesystem root",
      () => ({ ...plan(), stateRoot: "/" }),
      /canonical absolute path below \/sandbox/u,
    ],
    [
      "system state root",
      () => ({ ...plan(), stateRoot: "/etc/nemoclaw" }),
      /canonical absolute path below \/sandbox/u,
    ],
    [
      "state-root traversal",
      () => ({ ...plan(), stateRoot: "/sandbox/../etc" }),
      /canonical absolute path below \/sandbox/u,
    ],
    [
      "relative-path traversal",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "scripts/../../etc" }],
      }),
      /canonical relative path/u,
    ],
    [
      "control characters",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "scripts\u0000escape" }],
      }),
      /bounded exact string/u,
    ],
    [
      "an unpaired surrogate in the state root",
      () => ({ ...plan(), stateRoot: "/sandbox/state-\ud800" }),
      /Unicode scalar values/u,
    ],
    [
      "an unpaired surrogate in a selector path",
      () => ({
        ...plan(),
        selectors: [{ kind: "path", path: "state-\ud800" }],
      }),
      /Unicode scalar values/u,
    ],
    [
      "uppercase projection digest",
      () => ({
        ...plan(),
        projectionSha256: "A".repeat(64),
      }),
      /lowercase SHA-256/u,
    ],
    [
      "dot prefix",
      () => ({
        ...plan(),
        selectors: [{ kind: "prefix", prefix: "." }],
      }),
      /prefix is not canonical/u,
    ],
    [
      "dot-dot prefix",
      () => ({
        ...plan(),
        selectors: [{ kind: "prefix", prefix: ".." }],
      }),
      /prefix is not canonical/u,
    ],
  ])("rejects %s (#7744)", (_label, value, expected) => {
    expect(() => prepareRuntimeProviderStateMutationPlan(value())).toThrow(expected);
  });

  it("rejects duplicate, oversized, and UTF-8-aliasing selector sets (#7744)", () => {
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

    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...plan(),
        selectors: [{ kind: "path", path: "state-\ud800" }],
      }),
    ).toThrow(/Unicode scalar values/u);

    const replacementCharacter = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      selectors: [{ kind: "path", path: "state-\ufffd" }],
    });
    const ascii = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      selectors: [{ kind: "path", path: "state-x" }],
    });

    expect(replacementCharacter.plan.selectors).toEqual([{ kind: "path", path: "state-\ufffd" }]);
    expect(replacementCharacter.planSha256).not.toBe(ascii.planSha256);
  });
});
