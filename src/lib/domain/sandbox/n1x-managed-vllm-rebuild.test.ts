// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hostLocalInferenceReceipt,
  serializedHostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../../../../test/helpers/host-local-inference-receipt";
import {
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import { isRecordedN1xManagedVllmRebuildEligible } from "./n1x-managed-vllm-rebuild";

describe("recorded N1x managed-vLLM rebuild eligibility", () => {
  const n1xExpressEntry = {
    provider: "vllm-local",
    model: "nvidia/Qwen3.6-35B-A3B-NVFP4",
    endpointUrl: null,
    endpointSource: "onboard",
    openshellDriver: "docker",
  };
  const n1xExpressSelection = {
    provider: n1xExpressEntry.provider,
    model: n1xExpressEntry.model,
    pinEndpoint: true,
    endpointUrl: null,
  };
  const eligible = (
    sandboxEntry: Parameters<typeof isRecordedN1xManagedVllmRebuildEligible>[0],
    rebuildSelection: Parameters<
      typeof isRecordedN1xManagedVllmRebuildEligible
    >[1] = n1xExpressSelection,
  ) =>
    isRecordedN1xManagedVllmRebuildEligible(
      sandboxEntry,
      rebuildSelection,
      parseHostLocalInferenceReceipt,
    );

  it.each([
    { state: "derived endpoint and absent receipt", sandboxEntry: n1xExpressEntry },
    {
      state: "derived endpoint and null receipt",
      sandboxEntry: { ...n1xExpressEntry, hostLocalInferenceReceipt: null },
    },
    {
      state: "recorded canonical endpoint",
      sandboxEntry: {
        ...n1xExpressEntry,
        endpointUrl: "http://host.openshell.internal:8000/v1",
      },
    },
  ])("accepts the v0.0.109 N1x Express selection with a $state (#9292)", ({ sandboxEntry }) => {
    expect(eligible(sandboxEntry)).toBe(true);
  });

  it("accepts a canonical vLLM receipt on the exact N1x Express selection (#9292)", () => {
    const genericReceipt = hostLocalInferenceReceipt("docker");
    const n1xReceipt = serializeHostLocalInferenceReceipt({
      ...genericReceipt,
      endpoint: {
        ...genericReceipt.endpoint,
        host: "host.openshell.internal",
      },
      inference: {
        protocol: "openai-chat-completions",
        model: n1xExpressEntry.model,
        toolCallingRequired: true,
      },
    });

    expect(eligible({ ...n1xExpressEntry, hostLocalInferenceReceipt: n1xReceipt })).toBe(true);
  });

  it.each([
    {
      caseName: "different recorded provider",
      sandboxEntry: { ...n1xExpressEntry, provider: "compatible-endpoint" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different recorded model",
      sandboxEntry: { ...n1xExpressEntry, model: "meta-llama/Llama-3.1-8B-Instruct" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different recorded endpoint",
      sandboxEntry: { ...n1xExpressEntry, endpointUrl: "http://host.openshell.internal:8001/v1" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different endpoint source",
      sandboxEntry: { ...n1xExpressEntry, endpointSource: "inference-set" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different OpenShell driver",
      sandboxEntry: { ...n1xExpressEntry, openshellDriver: "podman" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "malformed receipt",
      sandboxEntry: { ...n1xExpressEntry, hostLocalInferenceReceipt: "not-json" },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different host-local service",
      sandboxEntry: {
        ...n1xExpressEntry,
        hostLocalInferenceReceipt: serializedLlamaCppHostLocalInferenceReceipt(),
      },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "conflicting vLLM receipt",
      sandboxEntry: {
        ...n1xExpressEntry,
        hostLocalInferenceReceipt: serializedHostLocalInferenceReceipt(),
      },
      rebuildSelection: n1xExpressSelection,
    },
    {
      caseName: "different rebuild provider",
      sandboxEntry: n1xExpressEntry,
      rebuildSelection: { ...n1xExpressSelection, provider: "compatible-endpoint" },
    },
    {
      caseName: "different rebuild model",
      sandboxEntry: n1xExpressEntry,
      rebuildSelection: { ...n1xExpressSelection, model: "meta-llama/Llama-3.1-8B-Instruct" },
    },
    {
      caseName: "unresolved rebuild endpoint",
      sandboxEntry: n1xExpressEntry,
      rebuildSelection: { ...n1xExpressSelection, pinEndpoint: false },
    },
    {
      caseName: "noncanonical rebuild endpoint",
      sandboxEntry: n1xExpressEntry,
      rebuildSelection: {
        ...n1xExpressSelection,
        endpointUrl: "http://host.openshell.internal:8001/v1",
      },
    },
  ])("rejects a $caseName (#9292)", ({ sandboxEntry, rebuildSelection }) => {
    expect(eligible(sandboxEntry, rebuildSelection)).toBe(false);
  });
});
