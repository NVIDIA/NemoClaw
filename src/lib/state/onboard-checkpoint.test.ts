// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { inspectCheckpoint, serializeCheckpoint } from "./onboard-checkpoint";
import {
  decisionDeclined,
  decisionFromLegacyNullable,
  decisionSelected,
  decisionsEqual,
  decisionUnset,
  isDecisionDeclined,
  isDecisionSelected,
  isDecisionUnset,
} from "./onboard-checkpoint-decision";
import { CHECKPOINT_SCHEMA_VERSION, type OnboardCheckpoint } from "./onboard-checkpoint-types";

const ISO = "2026-01-01T00:00:00.000Z";

function baseCheckpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "s1",
    machineState: "sandbox",
    updatedAt: ISO,
    sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionDeclined(),
    effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp-create" } },
    bindings: {
      credentialEnvs: ["OPENAI_API_KEY"],
      registeredProviders: [
        { name: "web-search-p", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      ],
    },
    ...overrides,
  };
}

describe("checkpoint decision tri-state", () => {
  it("distinguishes unset, declined, and selected", () => {
    expect(isDecisionUnset(decisionUnset())).toBe(true);
    expect(isDecisionDeclined(decisionDeclined())).toBe(true);
    const selected = decisionSelected("v");
    expect(isDecisionSelected(selected)).toBe(true);
    expect(selected.kind === "selected" && selected.value).toBe("v");
  });

  it("collapses legacy null using the completion marker (#6227/#5783)", () => {
    const parse = (raw: string): string | null => (raw.length > 0 ? raw : null);
    // never reached -> unset
    expect(decisionFromLegacyNullable(false, null, parse)).toEqual(decisionUnset());
    expect(decisionFromLegacyNullable(false, "x", parse)).toEqual(decisionUnset());
    // completed with an explicit null -> declined
    expect(decisionFromLegacyNullable(true, null, parse)).toEqual(decisionDeclined());
    // completed with a valid value -> selected
    expect(decisionFromLegacyNullable(true, "value", parse)).toEqual(decisionSelected("value"));
    // completed with an invalid value -> declined, never a false selection
    expect(decisionFromLegacyNullable(true, "", parse)).toEqual(decisionDeclined());
  });

  it("compares decisions by kind and value", () => {
    expect(decisionsEqual(decisionUnset(), decisionUnset())).toBe(true);
    expect(decisionsEqual(decisionUnset(), decisionDeclined())).toBe(false);
    expect(decisionsEqual(decisionSelected("a"), decisionSelected("a"))).toBe(true);
    expect(decisionsEqual(decisionSelected("a"), decisionSelected("b"))).toBe(false);
  });
});

describe("checkpoint schema inspection", () => {
  it("returns none for absent payloads", () => {
    expect(inspectCheckpoint(undefined)).toEqual({ status: "none" });
    expect(inspectCheckpoint(null)).toEqual({ status: "none" });
  });

  it("fails safe on an unknown future schema version instead of treating it as fresh (#6228)", () => {
    const result = inspectCheckpoint({
      ...serializeCheckpoint(baseCheckpoint()),
      schemaVersion: 99,
    });
    expect(result).toEqual({ status: "unsupported_future", foundVersion: 99 });
  });

  it("treats malformed version or payload as corrupt, not missing", () => {
    expect(inspectCheckpoint({ schemaVersion: 0 })).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint({ schemaVersion: "1" })).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint("nope")).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint({ schemaVersion: CHECKPOINT_SCHEMA_VERSION })).toEqual({
      status: "corrupt",
    });
  });

  it("loads and round-trips a valid v1 checkpoint", () => {
    const checkpoint = baseCheckpoint();
    const result = inspectCheckpoint(serializeCheckpoint(checkpoint));
    expect(result).toEqual({ status: "loaded", checkpoint });
  });

  it("rejects a checkpoint whose sandbox identity value is malformed", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).sandboxIdentity = {
      kind: "selected",
      value: { name: "Invalid Name", agent: "openclaw" },
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a malformed effect group record instead of silently dropping it", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).effectGroups = {
      sandbox_create: { completedAt: ISO, fingerprint: 42 },
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a non-object effect groups container instead of defaulting to empty", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).effectGroups = "not-an-object";
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects non-string entries inside checkpoint bindings instead of silently dropping them", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = {
      credentialEnvs: ["OPENAI_API_KEY", 42],
      registeredProviders: [
        { name: "web-search-p", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      ],
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a provider binding missing its type or credential environment instead of silently dropping it", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = {
      credentialEnvs: ["OPENAI_API_KEY"],
      registeredProviders: [{ name: "web-search-p", type: "brave" }],
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a non-object bindings container instead of defaulting to empty", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = "not-an-object";
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });
});
