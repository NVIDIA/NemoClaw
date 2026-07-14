// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect } from "vitest";

import type { RebuildFlowHarness } from "./rebuild-flow-harness";

export function makeDcodeSandboxEntry(): Record<string, unknown> {
  return {
    name: "alpha",
    agent: "langchain-deepagents-code",
    agentVersion: "0.1.12",
    nemoclawVersion: "0.0.72",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    endpointUrl: "https://inference-api.nvidia.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    nimContainer: null,
    policies: [],
    dashboardPort: 0,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    gpuEnabled: false,
    sandboxGpuEnabled: false,
    sandboxGpuMode: "0",
  };
}

export function configureDcodeSession(harness: RebuildFlowHarness): void {
  Object.assign(harness.session, {
    agent: "langchain-deepagents-code",
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3-super-120b-a12b",
    endpointUrl: "https://inference-api.nvidia.com/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai-completions",
    gpuPassthrough: false,
  });
}

export function expectNoDcodeMutation(harness: RebuildFlowHarness): void {
  expect(harness.openShieldsSpy).not.toHaveBeenCalled();
  expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
  expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
    ["sandbox", "delete", "alpha"],
    expect.anything(),
  );
  expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
  expect(harness.onboardSpy).not.toHaveBeenCalled();
}

export function setGatewayProviderMetadata(harness: RebuildFlowHarness, stdout: string): void {
  harness.runOpenshellSpy.mockImplementation((args: unknown) => {
    const argv = args as string[];
    return argv[0] === "provider" && argv[1] === "get"
      ? { status: 0, stdout, stderr: "" }
      : { status: 0, output: "" };
  });
}
