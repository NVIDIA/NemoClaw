// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
} from "../../../inference/native-local/contract";
import { LaunchReadinessEvidenceError, requireNativeInferenceHealth } from "./health";

const binding: NativeLocalBinding = {
  provider: "vllm-local",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  gatewayName: "selected",
  sandboxName: "alice",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
};
const receipt = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned",
};

describe.each(["openclaw", "langchain-deepagents-code"])(
  "%s native-local readiness",
  (agentName) => {
    function fixture(provider: string) {
      return {
        sandboxName: "alice",
        gatewayName: "selected",
        agentName,
        entry: {
          name: "alice",
          provider,
          model: "model-a",
          nativeLocalProviderAttachment: receipt,
        },
        deps: {
          verifyNativeLocalAttachment: vi.fn(async () => {}),
          inferenceInvocationProbe: vi.fn(async () => ({ ok: true as const })),
        },
      };
    }

    it("rejects a receipt for a different selected provider before any probe", async () => {
      const input = fixture("llama-cpp-local");
      await expect(requireNativeInferenceHealth(input)).rejects.toBeInstanceOf(
        LaunchReadinessEvidenceError,
      );
      expect(input.deps.verifyNativeLocalAttachment).not.toHaveBeenCalled();
      expect(input.deps.inferenceInvocationProbe).not.toHaveBeenCalled();
    });

    it("verifies and invokes the provider selected by the matching receipt", async () => {
      const input = fixture("vllm-local");
      await expect(requireNativeInferenceHealth(input)).resolves.toBe(true);
      expect(input.deps.verifyNativeLocalAttachment).toHaveBeenCalledExactlyOnceWith({
        sandboxName: "alice",
        gatewayName: "selected",
        expected: receipt,
      });
      expect(input.deps.inferenceInvocationProbe).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          provider: "vllm-local",
          model: "model-a",
          nativeLocalProviderAttachment: receipt,
        }),
      );
    });
  },
);
