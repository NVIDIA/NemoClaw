// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { requireProtectionTransitionPlan } from "../../../../test/helpers/runtime-provider-state-mutation-test-helpers";

import {
  prepareAgentDefinitionProtectionTransitionPlan,
  prepareRuntimeProviderStateMutationPlan,
} from "./state-mutation";

const PROJECTION_SHA256 = "a".repeat(64);

function plan() {
  return {
    schemaVersion: 2,
    intent: "restore",
    stateRoot: "/sandbox/.hermes",
    selectors: [
      { kind: "path", path: "cron" },
      { kind: "path", path: "scripts" },
      { kind: "prefix", prefix: "workspace-" },
    ],
    projectionSha256: PROJECTION_SHA256,
  };
}

function protectionTransitionPlan() {
  return {
    ...plan(),
    intent: "protection-transition",
    target: "locked",
    rollback: "mutable",
    stateLockPlan: {
      version: 1,
      readOnlyRoots: ["scripts"],
      confidentialRoots: ["cron"],
      readOnlyPrefixes: ["workspace-"],
      confidentialPrefixes: [],
      writableSubpaths: [],
    },
  };
}

describe("runtime provider state mutation plan", () => {
  it("compiles the complete AgentDefinition Shields projection into a bounded plan (#7744)", () => {
    const prepared = prepareAgentDefinitionProtectionTransitionPlan(
      {
        name: "hermes",
        configPaths: {
          dir: "/sandbox/.hermes",
          configFile: "config.yaml",
          envFile: ".env",
          format: "yaml",
          shieldsFiles: [".env"],
        },
        stateLockPlan: {
          version: 1,
          readOnlyRoots: ["skills", "hooks", "profiles"],
          confidentialRoots: ["pairing"],
          readOnlyPrefixes: ["workspace-"],
          confidentialPrefixes: [],
          writableSubpaths: ["profiles/dashboard-home"],
        },
      },
      "locked",
      "mutable",
    );

    expect(prepared.plan).toEqual({
      schemaVersion: 2,
      intent: "protection-transition",
      target: "locked",
      rollback: "mutable",
      stateRoot: "/sandbox/.hermes",
      selectors: [
        { kind: "path", path: ".config-hash" },
        { kind: "path", path: ".env" },
        { kind: "path", path: "config.yaml" },
        { kind: "path", path: "hooks" },
        { kind: "path", path: "pairing" },
        { kind: "path", path: "profiles" },
        { kind: "path", path: "skills" },
        { kind: "prefix", prefix: "workspace-" },
      ],
      stateLockPlan: {
        version: 1,
        readOnlyRoots: ["hooks", "profiles", "skills"],
        confidentialRoots: ["pairing"],
        readOnlyPrefixes: ["workspace-"],
        confidentialPrefixes: [],
        writableSubpaths: ["profiles/dashboard-home"],
      },
      projectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("binds writable exceptions into the projection digest (#7744)", () => {
    const agent = {
      name: "hermes",
      configPaths: {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: ".env",
        format: "yaml",
        shieldsFiles: [".env"],
      },
      stateLockPlan: {
        version: 1 as const,
        readOnlyRoots: ["profiles"],
        confidentialRoots: [],
        readOnlyPrefixes: [],
        confidentialPrefixes: [],
        writableSubpaths: ["profiles/dashboard-home"],
      },
    };
    const first = prepareAgentDefinitionProtectionTransitionPlan(agent, "locked", "mutable");
    const second = prepareAgentDefinitionProtectionTransitionPlan(
      {
        ...agent,
        stateLockPlan: { ...agent.stateLockPlan, writableSubpaths: [] },
      },
      "locked",
      "mutable",
    );

    expect(second.plan.selectors).toEqual(first.plan.selectors);
    const firstPlan = requireProtectionTransitionPlan(first.plan);
    const secondPlan = requireProtectionTransitionPlan(second.plan);
    expect(secondPlan.stateLockPlan.writableSubpaths).not.toEqual(
      firstPlan.stateLockPlan.writableSubpaths,
    );
    expect(second.projectionSha256).not.toBe(first.projectionSha256);
    expect(second.planSha256).not.toBe(first.planSha256);
  });

  it("includes an AgentDefinition environment file even when it is not duplicated as a shields file", () => {
    const prepared = prepareAgentDefinitionProtectionTransitionPlan(
      {
        name: "langchain-deepagents-code",
        configPaths: {
          dir: "/sandbox/.deepagents",
          configFile: "config.toml",
          envFile: ".env",
          format: "toml",
          shieldsFiles: [],
        },
        stateLockPlan: {
          version: 1,
          readOnlyRoots: [],
          confidentialRoots: [],
          readOnlyPrefixes: [],
          confidentialPrefixes: [],
          writableSubpaths: [],
        },
      },
      "locked",
      "mutable",
    );

    expect(prepared.plan.selectors).toEqual([
      { kind: "path", path: ".config-hash" },
      { kind: "path", path: ".env" },
      { kind: "path", path: "config.toml" },
    ]);
    expect(prepared.plan.intent).toBe("protection-transition");
    expect(requireProtectionTransitionPlan(prepared.plan).stateLockPlan.writableSubpaths).toEqual(
      [],
    );
  });

  it("rejects a noncanonical writable exception in the AgentDefinition projection", () => {
    expect(() =>
      prepareAgentDefinitionProtectionTransitionPlan(
        {
          name: "hermes",
          configPaths: {
            dir: "/sandbox/.hermes",
            configFile: "config.yaml",
            envFile: ".env",
            format: "yaml",
            shieldsFiles: [".env"],
          },
          stateLockPlan: {
            version: 1,
            readOnlyRoots: [],
            confidentialRoots: [],
            readOnlyPrefixes: [],
            confidentialPrefixes: [],
            writableSubpaths: ["profiles/../config.yaml"],
          },
        },
        "locked",
        "mutable",
      ),
    ).toThrow(
      "AgentDefinition state lock plan writable subpaths 0 must be a canonical relative path",
    );
  });

  it("does not let inherited JSON hooks replace the AgentDefinition projection digest", () => {
    const agent = {
      name: "hermes",
      configPaths: {
        dir: "/sandbox/.hermes",
        configFile: "config.yaml",
        envFile: ".env",
        format: "yaml",
        shieldsFiles: [".env"],
      },
      stateLockPlan: {
        version: 1 as const,
        readOnlyRoots: ["profiles"],
        confidentialRoots: [],
        readOnlyPrefixes: [],
        confidentialPrefixes: [],
        writableSubpaths: ["profiles/dashboard-home"],
      },
    };
    const baseline = prepareAgentDefinitionProtectionTransitionPlan(agent, "locked", "mutable");
    const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let polluted: ReturnType<typeof prepareAgentDefinitionProtectionTransitionPlan> | undefined;

    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        value: () => "polluted-object",
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => ["polluted-array"],
      });
      polluted = prepareAgentDefinitionProtectionTransitionPlan(agent, "locked", "mutable");
    } finally {
      objectToJson === undefined
        ? Reflect.deleteProperty(Object.prototype, "toJSON")
        : Object.defineProperty(Object.prototype, "toJSON", objectToJson);
      arrayToJson === undefined
        ? Reflect.deleteProperty(Array.prototype, "toJSON")
        : Object.defineProperty(Array.prototype, "toJSON", arrayToJson);
    }

    expect(polluted?.projectionSha256).toBe(baseline.projectionSha256);
    expect(polluted?.planSha256).toBe(baseline.planSha256);
  });

  it("binds a bounded scope to the AgentDefinition projection without copying it (#7744)", () => {
    const source = plan();
    const prepared = prepareRuntimeProviderStateMutationPlan(source);

    expect(prepared.plan).toEqual(source);
    expect(JSON.parse(prepared.serializedPlan)).toEqual(source);
    expect(prepared.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(prepared.projectionSha256).toBe(PROJECTION_SHA256);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.plan)).toBe(true);
    expect(Object.isFrozen(prepared.plan.selectors)).toBe(true);
    expect(Object.isFrozen(prepared.plan.selectors[0])).toBe(true);
    expect(Object.hasOwn(JSON.parse(prepared.serializedPlan), "stateLockPlan")).toBe(false);
    expect(Object.hasOwn(JSON.parse(prepared.serializedPlan), "writableSubpaths")).toBe(false);
    expect(prepared.plan).not.toBe(source);
  });

  it("canonicalizes selector order before computing the provider digest (#7744)", () => {
    const canonical = prepareRuntimeProviderStateMutationPlan(plan());
    const reordered = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      selectors: [...plan().selectors].reverse(),
    });

    expect(reordered.plan.selectors).toEqual(canonical.plan.selectors);
    expect(reordered.serializedPlan).toBe(canonical.serializedPlan);
    expect(reordered.planSha256).toBe(canonical.planSha256);
  });

  it("keeps the plan digest sensitive to intent, scope, and projection authority (#7744)", () => {
    const restore = prepareRuntimeProviderStateMutationPlan(plan());
    const protectionTransition = prepareRuntimeProviderStateMutationPlan(
      protectionTransitionPlan(),
    );
    const reversedTransition = prepareRuntimeProviderStateMutationPlan({
      ...protectionTransitionPlan(),
      target: "mutable",
      rollback: "locked",
    });
    const changedProjection = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      projectionSha256: "b".repeat(64),
    });
    const changedScope = prepareRuntimeProviderStateMutationPlan({
      ...plan(),
      selectors: [{ kind: "path", path: "scripts" }],
    });
    const changedWritableException = prepareRuntimeProviderStateMutationPlan({
      ...protectionTransitionPlan(),
      stateLockPlan: {
        ...protectionTransitionPlan().stateLockPlan,
        writableSubpaths: ["scripts/generated"],
      },
    });

    expect(protectionTransition.planSha256).not.toBe(restore.planSha256);
    expect(reversedTransition.planSha256).not.toBe(protectionTransition.planSha256);
    expect(changedProjection.planSha256).not.toBe(restore.planSha256);
    expect(changedScope.planSha256).not.toBe(restore.planSha256);
    expect(changedWritableException.planSha256).not.toBe(protectionTransition.planSha256);
    expect(changedProjection.projectionSha256).toBe("b".repeat(64));
  });

  it("keeps protection transitions distinct from restore plans (#7744)", () => {
    const source = protectionTransitionPlan();
    const protectionTransition = prepareRuntimeProviderStateMutationPlan(source);

    expect(protectionTransition.plan).toEqual(protectionTransitionPlan());
    expect(Object.isFrozen(protectionTransition.plan)).toBe(true);
    expect(protectionTransition.plan.intent).toBe("protection-transition");
    const protectionPlan = requireProtectionTransitionPlan(protectionTransition.plan);
    expect(protectionPlan.target).toBe("locked");
    expect(protectionPlan.rollback).toBe("mutable");
    expect(Object.isFrozen(protectionPlan.stateLockPlan)).toBe(true);
    expect(Object.isFrozen(protectionPlan.stateLockPlan.readOnlyRoots)).toBe(true);
    expect(Object.isFrozen(protectionPlan.stateLockPlan.writableSubpaths)).toBe(true);
    source.stateLockPlan.readOnlyRoots[0] = "changed-after-prepare";
    expect(protectionPlan.stateLockPlan.readOnlyRoots).toEqual(["scripts"]);
  });

  it.each([
    [
      "a protection transition without a target",
      () => {
        const { target: _target, ...value } = protectionTransitionPlan();
        return value;
      },
      /fields are unsupported/u,
    ],
    [
      "a protection transition without a rollback posture",
      () => {
        const { rollback: _rollback, ...value } = protectionTransitionPlan();
        return value;
      },
      /fields are unsupported/u,
    ],
    [
      "a protection transition without a state-lock policy",
      () => {
        const { stateLockPlan: _stateLockPlan, ...value } = protectionTransitionPlan();
        return value;
      },
      /fields are unsupported/u,
    ],
    [
      "an unsupported protection target",
      () => ({ ...protectionTransitionPlan(), target: "sealed" }),
      /target must be exactly locked or mutable/u,
    ],
    [
      "an unsupported protection rollback posture",
      () => ({ ...protectionTransitionPlan(), rollback: "restore" }),
      /rollback must be exactly locked or mutable/u,
    ],
    [
      "identical target and rollback postures",
      () => ({ ...protectionTransitionPlan(), rollback: "locked" }),
      /target and rollback postures must differ/u,
    ],
    [
      "a restore target posture",
      () => ({ ...plan(), target: "locked" }),
      /fields are unsupported/u,
    ],
    [
      "a restore rollback posture",
      () => ({ ...plan(), rollback: "mutable" }),
      /fields are unsupported/u,
    ],
    [
      "the prior schema version",
      () => ({ ...plan(), schemaVersion: 1 }),
      /version is unsupported/u,
    ],
    [
      "a restore state-lock policy",
      () => ({ ...plan(), stateLockPlan: protectionTransitionPlan().stateLockPlan }),
      /fields are unsupported/u,
    ],
    [
      "a legacy top-level writable exception",
      () => ({ ...plan(), writableSubpaths: [] }),
      /fields are unsupported/u,
    ],
    [
      "a legacy top-level writable exception on a protection transition",
      () => ({ ...protectionTransitionPlan(), writableSubpaths: [] }),
      /fields are unsupported/u,
    ],
    [
      "a state-lock policy with a missing field",
      () => {
        const base = protectionTransitionPlan();
        const { confidentialPrefixes: _confidentialPrefixes, ...stateLockPlan } =
          base.stateLockPlan;
        return { ...base, stateLockPlan };
      },
      /fields are unsupported/u,
    ],
    [
      "a state-lock policy with an unknown field",
      () => {
        const base = protectionTransitionPlan();
        return { ...base, stateLockPlan: { ...base.stateLockPlan, source: "ambient" } };
      },
      /fields are unsupported/u,
    ],
    [
      "a state-lock policy with a prior version",
      () => {
        const base = protectionTransitionPlan();
        return { ...base, stateLockPlan: { ...base.stateLockPlan, version: 0 } };
      },
      /version is unsupported/u,
    ],
    [
      "a protection policy outside the selected scope",
      () => ({
        ...protectionTransitionPlan(),
        stateLockPlan: {
          ...protectionTransitionPlan().stateLockPlan,
          readOnlyRoots: ["scripts", "other"],
        },
      }),
      /represented by exact selectors/u,
    ],
    [
      "a duplicate writable exception",
      () => ({
        ...protectionTransitionPlan(),
        stateLockPlan: {
          ...protectionTransitionPlan().stateLockPlan,
          writableSubpaths: ["scripts/generated", "scripts/generated"],
        },
      }),
      /must not contain duplicates/u,
    ],
    [
      "a writable exception beneath a confidential root",
      () => ({
        ...protectionTransitionPlan(),
        stateLockPlan: {
          ...protectionTransitionPlan().stateLockPlan,
          writableSubpaths: ["cron/generated"],
        },
      }),
      /beneath a read-only root/u,
    ],
  ])("rejects %s (#7744)", (_label, value, expected) => {
    expect(() => prepareRuntimeProviderStateMutationPlan(value())).toThrow(expected);
  });

  it.each([
    ["a one-component writable path", ["scripts"], /beneath a declared top-level root/u],
    ["a partial wildcard component", ["scripts/run*/output"], /only as a complete path component/u],
    ["a final wildcard component", ["scripts/*"], /may not end with a wildcard/u],
    [
      "overlapping wildcard paths",
      ["scripts/*/runs", "scripts/main/runs/output"],
      /must not overlap/u,
    ],
  ])("rejects %s in the nested state-lock grammar (#7744)", (_label, paths, expected) => {
    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...protectionTransitionPlan(),
        stateLockPlan: {
          ...protectionTransitionPlan().stateLockPlan,
          writableSubpaths: paths,
        },
      }),
    ).toThrow(expected);
  });

  it("accepts an OpenClaw-style wildcard writable exception (#7744)", () => {
    const base = protectionTransitionPlan();
    const prepared = prepareRuntimeProviderStateMutationPlan({
      ...base,
      selectors: [...base.selectors, { kind: "path", path: "agents" }],
      stateLockPlan: {
        ...base.stateLockPlan,
        readOnlyRoots: ["agents", "scripts"],
        writableSubpaths: ["agents/*/sessions"],
      },
    });

    expect(prepared.plan.intent).toBe("protection-transition");
    expect(requireProtectionTransitionPlan(prepared.plan).stateLockPlan.writableSubpaths).toEqual([
      "agents/*/sessions",
    ]);
  });

  it.each([
    [
      "one root in both policy classes",
      {
        readOnlyRoots: ["scripts"],
        confidentialRoots: ["scripts"],
      },
      /assigns one root more than once/u,
    ],
    [
      "one prefix in both policy classes",
      {
        readOnlyPrefixes: ["workspace-"],
        confidentialPrefixes: ["workspace-"],
      },
      /assigns one prefix more than once/u,
    ],
    [
      "overlapping root and prefix policies",
      {
        readOnlyRoots: ["scripts", "workspace-main"],
        readOnlyPrefixes: ["workspace-"],
      },
      /root and prefix policies must not overlap/u,
    ],
    [
      "overlapping prefixes",
      {
        readOnlyPrefixes: ["workspace-"],
        confidentialPrefixes: ["workspace-main"],
      },
      /prefix policies must not overlap/u,
    ],
  ])("rejects %s in the nested state-lock policy (#7744)", (_label, override, expected) => {
    const base = protectionTransitionPlan();
    expect(() =>
      prepareRuntimeProviderStateMutationPlan({
        ...base,
        stateLockPlan: { ...base.stateLockPlan, ...override },
      }),
    ).toThrow(expected);
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

    const accessorStateLockPlan = protectionTransitionPlan();
    Object.defineProperty(accessorStateLockPlan.stateLockPlan, "readOnlyRoots", {
      enumerable: true,
      get: () => ["scripts"],
    });
    expect(() => prepareRuntimeProviderStateMutationPlan(accessorStateLockPlan)).toThrow(
      /fixed data properties/u,
    );

    const accessorStateLockArray = protectionTransitionPlan();
    Object.defineProperty(accessorStateLockArray.stateLockPlan.readOnlyRoots, "0", {
      enumerable: true,
      get: () => "scripts",
    });
    expect(() => prepareRuntimeProviderStateMutationPlan(accessorStateLockArray)).toThrow(
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
