// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../../inference/bedrock-runtime";
import { nativeBedrockIdentity } from "../../inference/native-bedrock/contract";
import type { SandboxEntry } from "../../state/registry";
import type { SandboxInferenceInvocationInput } from "./inference-invocation-probe";
import { collectInferenceChecks } from "./doctor-inference";
import { requireNativeCompatibleInferenceHealth } from "./launch-readiness/health";
import { collectSandboxStatusSnapshot } from "./status-snapshot";

const binding = {
  endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  region: "us-east-1",
  adapterGeneration: "a".repeat(32),
  adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
  gatewayName: "nemoclaw-18080",
};
const receipt = {
  schemaVersion: 1 as const,
  providerId: "owned",
  ...nativeBedrockIdentity(binding),
  ...binding,
};
const entry = {
  name: "alpha",
  agent: "openclaw",
  gatewayName: binding.gatewayName,
  provider: "compatible-anthropic-endpoint",
  model: "anthropic.claude-test",
  endpointUrl: binding.endpointUrl,
  preferredInferenceApi: "openai-completions",
  nativeBedrockProviderAttachment: receipt,
} satisfies Partial<SandboxEntry>;

describe.each(["valid", "missing", "malformed", "stale", "pending"] as const)(
  "native Bedrock consumer %s",
  (state) => {
    function fixture() {
      const selected = {
        ...entry,
        ...(state === "pending" ? { pendingRouteReservation: true as const } : {}),
        nativeBedrockProviderAttachment:
          state === "missing"
            ? undefined
            : state === "malformed"
              ? { ...receipt, adapterGeneration: "invalid" }
              : receipt,
      };
      const verify = vi.fn<() => Promise<typeof receipt>>();
      verify.mockImplementation(
        state === "stale"
          ? async () => {
              throw new Error("Adapter generation changed.");
            }
          : async () => receipt,
      );
      const invoke = vi.fn<(input: SandboxInferenceInvocationInput) => Promise<{ ok: true }>>(
        async () => ({
          ok: true as const,
        }),
      );
      const managed = vi.fn(async () => {
        throw new Error("Managed route must not be observed.");
      });
      return { selected, verify, invoke, managed };
    }
    it("status verifies selection before invocation and never observes a managed route", async () => {
      const { selected, verify, invoke, managed } = fixture();
      const result = await collectSandboxStatusSnapshot("alpha", {
        deps: {
          getSandbox: () => selected as SandboxEntry,
          listPublishedSandboxesAcrossGatewayRoots: () => [selected as SandboxEntry],
          reconcile: async () => ({ state: "present" as const, output: "Phase: Ready" }),
          inferenceRouteObserver: { observeInferenceRoute: managed },
          verifyNativeBedrockProviderAttachmentImpl: verify,
          probeSandboxInferenceInvocationImpl: invoke,
          probeProviderHealthImpl: () => null,
          probeSandboxInferenceGatewayHealthImpl: managed,
        },
      });
      expect(result.currentModel).toBe(entry.model);
      expect(result.routeDrift).toBeNull();
      expect(result.inferenceHealth, JSON.stringify(result.inferenceHealth)).toMatchObject({
        ok: state === "valid",
        probed: state === "valid",
      });
      expect(managed).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(state === "valid" ? 1 : 0);
      expect(
        invoke.mock.calls.map(([input]) => ({
          receipt: input.nativeBedrockProviderAttachment,
          gatewayName: input.gatewayName,
        })),
      ).toEqual(state === "valid" ? [{ receipt, gatewayName: binding.gatewayName }] : []);
    });
    it("doctor fails closed before invocation when ownership cannot be proved", async () => {
      const { selected, verify, invoke, managed } = fixture();
      const checks = await collectInferenceChecks(
        "alpha",
        {
          ...selected,
          recordedEndpointUrl: selected.endpointUrl,
        },
        true,
        {
          gatewayName: binding.gatewayName,
          verifyNativeBedrockProviderAttachmentImpl: verify,
          probeSandboxInferenceInvocationImpl: invoke,
          probeSandboxInferenceGatewayHealthImpl: managed,
          probeProviderHealthImpl: () => null,
        },
      );
      expect(checks).toContainEqual(
        expect.objectContaining({
          label: "Inference route (native Bedrock)",
          status: state === "valid" ? "ok" : "fail",
        }),
      );
      expect(managed).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledTimes(state === "valid" ? 1 : 0);
    });
    it("launch readiness requires exact ownership before a fresh native invocation", async () => {
      const { selected, verify, invoke } = fixture();
      const outcome = requireNativeCompatibleInferenceHealth({
        sandboxName: "alpha",
        gatewayName: binding.gatewayName,
        entry: selected,
        deps: { verifyNativeBedrockAttachment: verify, inferenceInvocationProbe: invoke },
      });
      await expect(
        outcome.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      ).resolves.toEqual(state === "valid" ? { value: true } : { error: expect.any(Error) });
      expect(invoke).toHaveBeenCalledTimes(state === "valid" ? 1 : 0);
    });
  },
);
