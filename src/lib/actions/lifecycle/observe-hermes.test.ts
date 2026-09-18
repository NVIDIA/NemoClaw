// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type {
  OpenShellHermesAgentHealthEvidence,
  OpenShellHermesAgentObservation,
  OpenShellHermesAgentObserver,
} from "../../adapters/openshell/hermes-agent-observer";
import {
  NEMOCLAW_LIFECYCLE_API_VERSION,
  type HermesLifecycleObserveRequest,
  type HermesLifecyclePlanRequest,
  type HermesLifecycleSandboxPhase,
  type LifecycleVerificationField,
} from "../../domain/lifecycle/contract";
import { HERMES_LIFECYCLE_DEFINITION } from "../../domain/lifecycle/hermes-definition";
import { observeHermesLifecycle } from "./observe-hermes";

const GATEWAY_IDENTITY = `sha256:${"1".repeat(64)}` as const;
const RESOURCE_IDENTITY = `sha256:${"2".repeat(64)}` as const;
const IMAGE_DIGEST = `sha256:${"3".repeat(64)}` as const;
const CONFIGURATION_FINGERPRINT = `sha256:${"4".repeat(64)}` as const;

function planRequest(): HermesLifecyclePlanRequest {
  return {
    apiVersion: NEMOCLAW_LIFECYCLE_API_VERSION,
    target: {
      gatewayIdentity: GATEWAY_IDENTITY,
      workspace: "hermes-workspace",
      openshellVersion: HERMES_LIFECYCLE_DEFINITION.openshellVersion,
    },
    sandbox: {
      name: "hermes-agent",
      resourceIdentity: RESOURCE_IDENTITY,
      imageDigest: IMAGE_DIGEST,
      configurationFingerprint: CONFIGURATION_FINGERPRINT,
    },
  };
}

type PresentObservation = Extract<OpenShellHermesAgentObservation, { state: "present" }>;

function observed(
  phase: HermesLifecycleSandboxPhase = "Ready",
  health: OpenShellHermesAgentHealthEvidence = { state: "reachable", statusCode: 200 },
): PresentObservation {
  return {
    state: "present",
    target: planRequest().target,
    sandbox: {
      name: "hermes-agent",
      resourceIdentity: RESOURCE_IDENTITY,
      imageDigest: IMAGE_DIGEST,
      phase,
    },
    agent: {
      name: "hermes",
      version: "0.20.6",
      configurationFingerprint: CONFIGURATION_FINGERPRINT,
      health,
    },
  };
}

function request(): HermesLifecycleObserveRequest {
  return { plan: planRequest(), timeoutMs: 5_000 };
}

function observerWith(value: OpenShellHermesAgentObservation): {
  capability: OpenShellHermesAgentObserver;
  observe: ReturnType<typeof vi.fn>;
} {
  const observe = vi.fn().mockResolvedValue({ ok: true, value });
  return { capability: { observeHermesAgent: observe }, observe };
}

describe("Hermes lifecycle observation", () => {
  it("returns ready after the injected capability verifies every field (#10613)", async () => {
    const { capability, observe } = observerWith(observed());

    const result = await observeHermesLifecycle(request(), capability);

    expect(observe).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledWith({
      target: planRequest().target,
      sandboxName: "hermes-agent",
      resourceIdentity: RESOURCE_IDENTITY,
      timeoutMs: 5_000,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        apiVersion: "v1alpha1",
        state: "present",
        agent: { name: "hermes", version: "0.20.6", readiness: "ready" },
        target: planRequest().target,
        sandbox: {
          ...planRequest().sandbox,
          phase: "Ready",
          readiness: "ready",
        },
        readiness: "ready",
      },
    });
  });

  it.each([
    ["Creating", { state: "reachable", statusCode: 200 }, "not_ready"],
    ["Ready", { state: "unreachable" }, "not_ready"],
    ["Failed", { state: "reachable", statusCode: 200 }, "terminal"],
    ["Ready", { state: "reachable", statusCode: 503 }, "not_ready"],
  ] as const)(
    "derives readiness from phase %s and health case %# without retrying (#10613)",
    async (phase, health, expected) => {
      const { capability, observe } = observerWith(observed(phase, health));

      const result = await observeHermesLifecycle(request(), capability);

      expect(result.ok && result.value.readiness).toBe(expected);
      expect(observe).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "CrashLoopBackOff",
    "Error",
    "Evicted",
    "Failed",
    "ImagePullBackOff",
    "Unknown",
  ] as const)("maps terminal OpenShell phase %s to terminal (#10613)", async (phase) => {
    const { capability } = observerWith(observed(phase));

    const result = await observeHermesLifecycle(request(), capability);

    expect(result.ok && result.value.readiness).toBe("terminal");
  });

  it("reports a missing OpenShell resource without treating it as a capability failure (#10613)", async () => {
    const observe = vi.fn().mockResolvedValue({ ok: true, value: { state: "missing" } });

    const result = await observeHermesLifecycle(request(), { observeHermesAgent: observe });

    expect(result).toEqual({
      ok: true,
      value: {
        apiVersion: "v1alpha1",
        state: "missing",
        target: planRequest().target,
        sandbox: { name: "hermes-agent", resourceIdentity: RESOURCE_IDENTITY },
        readiness: "not_ready",
      },
    });
  });

  it.each<[LifecycleVerificationField, (value: PresentObservation) => PresentObservation]>([
    [
      "target.gatewayIdentity",
      (value) => ({
        ...value,
        target: { ...value.target, gatewayIdentity: `sha256:${"5".repeat(64)}` },
      }),
    ],
    [
      "target.workspace",
      (value) => ({ ...value, target: { ...value.target, workspace: "other-workspace" } }),
    ],
    [
      "target.openshellVersion",
      (value) => ({ ...value, target: { ...value.target, openshellVersion: "0.0.115" } }),
    ],
    ["sandbox.name", (value) => ({ ...value, sandbox: { ...value.sandbox, name: "other-agent" } })],
    [
      "sandbox.resourceIdentity",
      (value) => ({
        ...value,
        sandbox: { ...value.sandbox, resourceIdentity: `sha256:${"6".repeat(64)}` },
      }),
    ],
    [
      "sandbox.imageDigest",
      (value) => ({
        ...value,
        sandbox: { ...value.sandbox, imageDigest: `sha256:${"7".repeat(64)}` },
      }),
    ],
    ["agent.name", (value) => ({ ...value, agent: { ...value.agent, name: "openclaw" } })],
    ["agent.version", (value) => ({ ...value, agent: { ...value.agent, version: "0.20.0" } })],
    [
      "agent.configurationFingerprint",
      (value) => ({
        ...value,
        agent: { ...value.agent, configurationFingerprint: `sha256:${"8".repeat(64)}` },
      }),
    ],
  ])("fails closed when %s does not match (#10613)", async (field, change) => {
    const { capability } = observerWith(change(observed()));

    const result = await observeHermesLifecycle(request(), capability);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "verification-failed",
        field,
        message: `Hermes lifecycle verification failed: ${field}.`,
      },
    });
  });

  it("snapshots capability evidence once before verification (#10613)", async () => {
    const value = observed();
    let reads = 0;
    const target = Object.defineProperty({ ...value.target }, "gatewayIdentity", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? GATEWAY_IDENTITY : "private-endpoint-value";
      },
    });
    const { capability } = observerWith({ ...value, target } as PresentObservation);

    const result = await observeHermesLifecycle(request(), capability);

    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-endpoint-value");
  });

  it.each([
    [
      "private-success-workspace",
      (value: PresentObservation) => ({
        ...value,
        target: { ...value.target, workspace: "private-success-workspace" },
      }),
    ],
    [
      "private-success-phase",
      (value: PresentObservation) => ({
        ...value,
        sandbox: { ...value.sandbox, phase: "private-success-phase" },
      }),
    ],
    [
      "private-success-health",
      (value: PresentObservation) => ({
        ...value,
        agent: { ...value.agent, health: { state: "private-success-health" } },
      }),
    ],
    [
      "private-success-extra",
      (value: PresentObservation) => ({ ...value, credential: "private-success-extra" }),
    ],
  ])(
    "does not retain capability-supplied private data case %# (#10613)",
    async (privateValue, change) => {
      const { capability } = observerWith(change(observed()) as PresentObservation);

      const result = await observeHermesLifecycle(request(), capability);

      expect(JSON.stringify(result)).not.toContain(privateValue);
    },
  );

  it.each(["authentication", "command", "schema", "timeout", "transport"] as const)(
    "redacts a capability %s failure and does not retry (#10613)",
    async (kind) => {
      const privateValue = "private-observer-value";
      const observe = vi.fn().mockResolvedValue({
        ok: false,
        error: { kind, message: `${privateValue} https://private.invalid` },
      });

      const result = await observeHermesLifecycle(request(), { observeHermesAgent: observe });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "capability-failure",
          reason: kind,
          message: `OpenShell agent observation failed: ${kind}.`,
        },
      });
      expect(JSON.stringify(result)).not.toContain(privateValue);
      expect(JSON.stringify(result)).not.toContain("private.invalid");
      expect(observe).toHaveBeenCalledOnce();
    },
  );

  it("returns a redacted exception failure when the capability throws (#10613)", async () => {
    const observe = vi.fn().mockRejectedValue(new Error("private thrown value"));

    const result = await observeHermesLifecycle(request(), { observeHermesAgent: observe });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "capability-failure",
        reason: "exception",
        message: "OpenShell agent observation failed: exception.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private thrown value");
  });

  it.each(["method", "response"] as const)(
    "redacts a throwing capability %s accessor (#10613)",
    async (accessor) => {
      const privateValue = `private-${accessor}-accessor`;
      const capability =
        accessor === "method"
          ? Object.defineProperty({}, "observeHermesAgent", {
              get() {
                throw new Error(privateValue);
              },
            })
          : {
              observeHermesAgent: vi.fn().mockResolvedValue(
                Object.defineProperty({}, "ok", {
                  get() {
                    throw new Error(privateValue);
                  },
                }),
              ),
            };

      const result = await observeHermesLifecycle(
        request(),
        capability as OpenShellHermesAgentObserver,
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "capability-failure",
          reason: "exception",
          message: "OpenShell agent observation failed: exception.",
        },
      });
      expect(JSON.stringify(result)).not.toContain(privateValue);
    },
  );

  it("rejects an invalid request before the capability runs (#10613)", async () => {
    const { capability, observe } = observerWith(observed());
    const invalid = { ...request(), timeoutMs: 0 };

    const result = await observeHermesLifecycle(invalid, capability);

    expect(result).toMatchObject({ ok: false, error: { field: "timeoutMs" } });
    expect(observe).not.toHaveBeenCalled();
  });

  it("redacts a throwing request accessor before the capability runs (#10613)", async () => {
    const { capability, observe } = observerWith(observed());
    const hostileRequest = Object.defineProperty({}, "plan", {
      enumerable: true,
      get() {
        throw new Error("private-request-value");
      },
    }) as HermesLifecycleObserveRequest;

    const result = await observeHermesLifecycle(hostileRequest, capability);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        field: "request",
        message: "Invalid lifecycle request field: request.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-request-value");
    expect(observe).not.toHaveBeenCalled();
  });
});
