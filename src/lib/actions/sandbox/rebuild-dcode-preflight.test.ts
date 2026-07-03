// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { revalidateDcodeReplacementAtMutationEdge } from "./rebuild-dcode-preflight";

describe("DCode rebuild preflight", () => {
  it("rejects prepared-image tool-disclosure drift before gateway or mutation work", async () => {
    const checkGatewaySchema = vi.fn(() => true);
    const verify = vi.fn(() => true);
    const dispose = vi.fn(() => true);

    await expect(
      revalidateDcodeReplacementAtMutationEdge({
        sandboxName: "alpha",
        entry: {
          name: "alpha",
          agent: "langchain-deepagents-code",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        },
        resumeConfig: {
          agent: "langchain-deepagents-code",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-super-120b-a12b",
          endpointUrl: "https://inference-api.nvidia.com/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "false",
          nimContainer: null,
          pinEndpoint: true,
          ambient: { presentVars: [], agentMismatch: null },
        },
        toolDisclosure: "direct",
        skipLiveRoute: true,
        gatewayPort: 8080,
        log: vi.fn(),
        bail: (message): never => {
          throw new Error(message);
        },
        checkGatewaySchema,
        replacement: {
          buildContext: {} as never,
          gatewayName: "nemoclaw",
          toolDisclosure: "progressive",
          verify,
          dispose,
        },
      }),
    ).rejects.toThrow("prepared DCode tool-disclosure mode changed before deletion");

    expect(checkGatewaySchema).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});
