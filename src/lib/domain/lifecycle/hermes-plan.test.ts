// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { NEMOCLAW_LIFECYCLE_API_VERSION, type HermesLifecyclePlanRequest } from "./contract";
import { HERMES_LIFECYCLE_DEFINITION } from "./hermes-definition";
import { planHermesLifecycle } from "./hermes-plan";

const GATEWAY_IDENTITY = `sha256:${"1".repeat(64)}` as const;
const RESOURCE_IDENTITY = `sha256:${"2".repeat(64)}` as const;
const IMAGE_DIGEST = `sha256:${"3".repeat(64)}` as const;
const CONFIGURATION_FINGERPRINT = `sha256:${"4".repeat(64)}` as const;

function validRequest(): HermesLifecyclePlanRequest {
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

describe("Hermes lifecycle planning", () => {
  it("returns the same frozen observation plan for the same request (#10613)", () => {
    const request = validRequest();
    const original = structuredClone(request);

    const first = planHermesLifecycle(request);
    const second = planHermesLifecycle(request);

    expect(first).toEqual(second);
    expect(request).toEqual(original);
    expect(first).toEqual({
      ok: true,
      value: {
        apiVersion: "v1alpha1",
        operation: "observe",
        agent: { name: "hermes", version: "0.19.0" },
        target: request.target,
        sandbox: request.sandbox,
        checks: [
          "target",
          "resource-identity",
          "image",
          "agent",
          "configuration",
          "sandbox-readiness",
          "agent-readiness",
        ],
      },
    });
    expect(first.ok && Object.isFrozen(first.value)).toBe(true);
    expect(first.ok && Object.isFrozen(first.value.target)).toBe(true);
    expect(first.ok && Object.isFrozen(first.value.sandbox)).toBe(true);
  });

  it.each([
    ["apiVersion", { ...validRequest(), apiVersion: "v2" }],
    [
      "target.gatewayIdentity",
      { ...validRequest(), target: { ...validRequest().target, gatewayIdentity: "gateway-one" } },
    ],
    [
      "target.workspace",
      { ...validRequest(), target: { ...validRequest().target, workspace: "Hermes Workspace" } },
    ],
    [
      "target.openshellVersion",
      { ...validRequest(), target: { ...validRequest().target, openshellVersion: "0.0.115" } },
    ],
    ["sandbox.name", { ...validRequest(), sandbox: { ...validRequest().sandbox, name: "--help" } }],
    [
      "sandbox.resourceIdentity",
      { ...validRequest(), sandbox: { ...validRequest().sandbox, resourceIdentity: "resource" } },
    ],
    [
      "sandbox.imageDigest",
      {
        ...validRequest(),
        sandbox: { ...validRequest().sandbox, imageDigest: `sha256:${"A".repeat(64)}` },
      },
    ],
    [
      "sandbox.configurationFingerprint",
      {
        ...validRequest(),
        sandbox: { ...validRequest().sandbox, configurationFingerprint: "sha256:short" },
      },
    ],
  ])("rejects an invalid %s without returning the value (#10613)", (field, request) => {
    expect(planHermesLifecycle(request as HermesLifecyclePlanRequest)).toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        field,
        message: `Invalid lifecycle request field: ${field}.`,
      },
    });
  });

  it("rejects agent, endpoint, and credential fields without retaining their values (#10613)", () => {
    const privateValue = "private-lifecycle-value";
    const request = {
      ...validRequest(),
      agent: "openclaw",
      endpoint: `https://${privateValue}.invalid`,
      credential: privateValue,
    } as unknown as HermesLifecyclePlanRequest;

    const result = planHermesLifecycle(request);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        field: "request",
        message: "Invalid lifecycle request field: request.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateValue);
  });

  it("snapshots request values once before retaining the plan (#10613)", () => {
    const request = validRequest();
    let reads = 0;
    const target = Object.defineProperty({ ...request.target }, "gatewayIdentity", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? GATEWAY_IDENTITY : "private-endpoint-value";
      },
    });

    const result = planHermesLifecycle({ ...request, target } as HermesLifecyclePlanRequest);

    expect(result.ok && result.value.target.gatewayIdentity).toBe(GATEWAY_IDENTITY);
    expect(reads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-endpoint-value");
  });

  it("redacts a throwing request accessor (#10613)", () => {
    const request = validRequest();
    const target = Object.defineProperty({ ...request.target }, "workspace", {
      enumerable: true,
      get() {
        throw new Error("private-request-value");
      },
    });

    const result = planHermesLifecycle({ ...request, target } as HermesLifecyclePlanRequest);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        field: "request",
        message: "Invalid lifecycle request field: request.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("private-request-value");
  });
});
