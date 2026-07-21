// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decisionSelected, decisionUnset } from "../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import { planEffectGroupReplay, planSandboxCreateReplay } from "./checkpoint-replay";
import { bindingRevalidationGuidance, revalidateCheckpointBindings } from "./checkpoint-revalidate";

const ISO = "2026-01-01T00:00:00.000Z";

function checkpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "s1",
    machineState: "sandbox",
    updatedAt: ISO,
    sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    ...overrides,
  };
}

describe("planEffectGroupReplay", () => {
  it("runs an unrecorded effect group", () => {
    expect(planEffectGroupReplay(checkpoint(), "messaging_providers", true).action).toBe("run");
  });

  it("re-runs a recorded group whose postcondition no longer holds (never blind skip)", () => {
    const cp = checkpoint({
      effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "fp" } },
    });
    const decision = planEffectGroupReplay(cp, "messaging_providers", false);
    expect(decision).toEqual({
      group: "messaging_providers",
      action: "run",
      reason: "postcondition_failed",
    });
  });

  it("skips a recorded group only after its postcondition is revalidated", () => {
    const cp = checkpoint({
      effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planEffectGroupReplay(cp, "messaging_providers", true).action).toBe("skip");
  });
});

describe("planSandboxCreateReplay never opens a second sandbox (#5961)", () => {
  it("requires identity capture before any create when identity is not durable", () => {
    const cp = checkpoint({ sandboxIdentity: decisionUnset() });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: false })).toEqual({
      action: "capture_identity_first",
    });
  });

  it("reuses the live sandbox when create is recorded and it still exists", () => {
    const cp = checkpoint({
      effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: true })).toEqual({
      action: "reuse",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("recreates under the SAME durable identity when the sandbox is gone, never a new name", () => {
    const cp = checkpoint({
      effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: false })).toEqual({
      action: "create",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("creates under the durable identity when create was never recorded", () => {
    expect(planSandboxCreateReplay(checkpoint(), { liveSandboxExists: false })).toEqual({
      action: "create",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("reuses a live sandbox even when the create receipt was lost to a mid-create crash (#7022)", () => {
    expect(planSandboxCreateReplay(checkpoint(), { liveSandboxExists: true })).toEqual({
      action: "reuse",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });
});

describe("crash-then-resume matrix proves at-most-once destructive create (#6228)", () => {
  const states = [
    "sandbox",
    "openclaw",
    "agent_setup",
    "policies",
    "finalizing",
    "post_verify",
  ] as const;

  it.each(
    states,
  )("crash at %s: reuse a surviving sandbox, recreate under the same identity when it is gone", (state) => {
    const cp = checkpoint({
      machineState: state,
      effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: true }).action).toBe("reuse");
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: false })).toEqual({
      action: "create",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });
});

describe("revalidateCheckpointBindings fails closed without leaking values (#6228)", () => {
  it("passes when every binding is currently available", () => {
    const cp = checkpoint({
      bindings: {
        credentialEnvs: ["OPENAI_API_KEY"],
        registeredProviders: [{ name: "p1", type: "generic", credentialEnv: "P1_API_KEY" }],
      },
    });
    const result = revalidateCheckpointBindings(cp, {
      availableCredentialEnvs: new Set(["OPENAI_API_KEY"]),
      liveRegisteredProviders: new Set(["p1"]),
    });
    expect(result).toEqual({ status: "ok" });
    expect(bindingRevalidationGuidance(result)).toBeNull();
  });

  it("fails closed on a stale binding and reports only names, never values", () => {
    const cp = checkpoint({
      bindings: {
        credentialEnvs: ["OPENAI_API_KEY"],
        registeredProviders: [{ name: "p1", type: "generic", credentialEnv: "P1_API_KEY" }],
      },
    });
    const result = revalidateCheckpointBindings(cp, {
      availableCredentialEnvs: new Set(),
      liveRegisteredProviders: new Set(),
    });
    expect(result).toEqual({
      status: "stale",
      missingCredentialEnvs: ["OPENAI_API_KEY"],
      missingProviders: ["p1"],
    });
    const guidance = bindingRevalidationGuidance(result);
    expect(guidance).toContain("OPENAI_API_KEY");
    expect(guidance).toContain("p1");
  });
});
