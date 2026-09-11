// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspectPolicyMutationContext: vi.fn(),
  loadExternalComponentDeclaration: vi.fn(),
}));

vi.mock("../../policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../policy")>()),
  inspectPolicyMutationContext: mocks.inspectPolicyMutationContext,
}));

vi.mock("./index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index")>()),
  loadExternalComponentDeclaration: mocks.loadExternalComponentDeclaration,
}));

import { fingerprintOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
import { ExternalComponentContractError, type PreparedExternalComponent } from "./index";
import {
  assertExternalComponentFreshSandbox,
  finalDeps,
  prepareExternalComponent,
} from "./onboarding";

describe("external component onboarding lifecycle", () => {
  beforeEach(() => {
    mocks.inspectPolicyMutationContext.mockReset();
    mocks.loadExternalComponentDeclaration.mockReset();
    mocks.loadExternalComponentDeclaration.mockReturnValue(null);
  });

  it("accepts an explicit sandbox name when the sandbox is absent (#11340)", () => {
    const inspectSandboxForCreate = vi.fn(() => ({
      existingEntry: null,
      preservedMcpState: undefined,
      liveExists: false,
    }));

    expect(() =>
      assertExternalComponentFreshSandbox("new-sandbox", inspectSandboxForCreate),
    ).not.toThrow();
    expect(inspectSandboxForCreate).toHaveBeenCalledWith("new-sandbox");
  });

  it("requires an explicit sandbox name before gateway changes (#11340)", () => {
    const inspectSandboxForCreate = vi.fn();

    expect(() => assertExternalComponentFreshSandbox(null, inspectSandboxForCreate)).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
    expect(inspectSandboxForCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["a registered sandbox", { existingEntry: {} as never, liveExists: false }],
    ["a live sandbox", { existingEntry: null, liveExists: true }],
  ])("rejects %s before gateway changes (#11340)", (_title, inspected) => {
    const inspectSandboxForCreate = vi.fn(() => ({
      ...inspected,
      preservedMcpState: undefined,
    }));

    expect(() =>
      assertExternalComponentFreshSandbox("existing-sandbox", inspectSandboxForCreate),
    ).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
  });

  it("does not retry an incomplete activation automatically (#11340)", () => {
    expect(() =>
      prepareExternalComponent({
        externalComponentActivation: {
          schemaVersion: 1,
          resultClass: "ambiguous",
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ExternalComponentContractError>>({
        code: "lifecycle_unsupported",
      }),
    );
  });

  it("activates with final proof from registry, policy, and OpenShell evidence (#11340)", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "nc-component-final-deps-"));
    const socketPath = path.join(root, "activation.sock");
    const sandboxId = "sandbox-123";
    const sandboxName = "assistant";
    const gatewayName = "managed-gateway";
    const lifecycleGeneration = "generation-7";
    const policyHash = `sha256:${"a".repeat(64)}`;
    const identityFingerprint = `sha256:${fingerprintOpenShellSandboxId(sandboxId)}`;
    const registry = {
      getSandbox: vi.fn(() => ({
        name: sandboxName,
        gatewayName,
        gatewayPort: 8080,
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: fingerprintOpenShellSandboxId(sandboxId)!,
      })),
      setDefault: vi.fn(),
    };
    const runCaptureOpenshell = vi.fn(() =>
      JSON.stringify([
        {
          id: sandboxId,
          name: sandboxName,
          labels: {},
          resource_version: 9,
          created_at: "2026-09-10T00:00:00Z",
          phase: "Ready",
          current_policy_version: 4,
        },
      ]),
    );
    mocks.inspectPolicyMutationContext.mockReturnValue({
      basePolicyDocument:
        "version: 1\nnetwork_policies:\n  inference:\n    endpoints:\n      - host: example.test\n",
      gatewayName,
      inspection: {
        policySource: "sandbox",
        effectivePolicy: {
          version: 1,
          network_policies: {
            inference: { endpoints: [{ host: "example.test", port: 443 }] },
          },
        },
        policyIdentity: { hash: policyHash, activeVersion: 4 },
      },
    });
    let resolveRequest!: (request: Record<string, unknown>) => void;
    const received = new Promise<Record<string, unknown>>((resolve) => {
      resolveRequest = resolve;
    });
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const activationRequest = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          activationId: string;
          componentId: string;
          policy: { hash: string };
          sandbox: Record<string, unknown> & { id: string };
        };
        resolveRequest(activationRequest);
        const responseBody = JSON.stringify({
          schemaVersion: 1,
          activationId: activationRequest.activationId,
          componentId: activationRequest.componentId,
          sandboxId: activationRequest.sandbox.id,
          policyHash: activationRequest.policy.hash,
          result: "activated",
        });
        response.writeHead(200, { "Content-Length": String(Buffer.byteLength(responseBody)) });
        response.end(responseBody);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      const deps = finalDeps(
        gatewayName,
        { updateSession: vi.fn() },
        registry,
        runCaptureOpenshell,
      );
      const proof = await deps.createExternalComponentActivationProof(sandboxName);
      const component: PreparedExternalComponent = {
        declaration: {
          schemaVersion: 1,
          componentId: "policy-governance",
          interceptorSocketPath: path.join(root, "interceptor.sock"),
          activationSocketPath: socketPath,
        },
        revalidateBeforeGateway: vi.fn(),
        revalidateBeforeActivation: vi.fn(),
      };
      const result = await deps.activateExternalComponent(
        component,
        proof,
        "123e4567-e89b-42d3-a456-426614174000",
      );
      const activationRequest = await received;

      expect(result).toEqual({ kind: "activated" });
      expect(runCaptureOpenshell).toHaveBeenCalledWith(
        ["sandbox", "list", "-g", gatewayName, "--output", "json"],
        { ignoreError: false },
      );
      expect(mocks.inspectPolicyMutationContext).toHaveBeenCalledWith(
        sandboxName,
        "verify external component activation policy",
        gatewayName,
      );
      expect(activationRequest).toMatchObject({
        sandbox: { id: sandboxId, identityFingerprint, lifecycleGeneration },
        policy: { hash: policyHash },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])(
    "preserves registration with providerless selection %s (#11486)",
    (apfInterceptorRequested) => {
      const component = {} as PreparedExternalComponent;
      mocks.loadExternalComponentDeclaration.mockReturnValue(component);
      expect(prepareExternalComponent({ apfInterceptorRequested })).toBe(component);
      mocks.loadExternalComponentDeclaration.mockReturnValue(null);
      expect(prepareExternalComponent({ apfInterceptorRequested })).toBeNull();
    },
  );
});
