// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from "vitest";
import type { OpenShellSandboxBufferedCommandRequest } from "../adapters/openshell/sandbox-command";
import { nativeBedrockIdentity } from "../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../inference/bedrock-runtime";
import { verifyCompatibleEndpointSandboxSmoke } from "./compatible-endpoint-smoke";
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../inference/native-bedrock/profile", () => ({
  verifyNativeBedrockProviderAttachment: verify,
}));
function fixture() {
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName: "named-gateway",
  };
  const receipt = {
    ...binding,
    ...nativeBedrockIdentity(binding),
    schemaVersion: 1 as const,
    providerId: "owned",
  };
  const runBuffered = vi.fn(async (_request: OpenShellSandboxBufferedCommandRequest) => ({
    outcome: { kind: "completed" as const, exitCode: 0 },
    stdout: _request.command.at(-1)?.includes("OPENCLAW_NATIVE_CONFIG_OK")
      ? "OPENCLAW_NATIVE_CONFIG_OK\n"
      : '200\n{"choices":[{"message":{"content":"PONG"}}]}',
    stderr: "",
  }));
  const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const beforeSuccess = vi.fn();
  return {
    receipt,
    runBuffered,
    runOpenshell,
    beforeSuccess,
    options: {
      sandboxName: "selected",
      provider: "compatible-anthropic-endpoint",
      model: "model-a",
      endpointUrl: binding.endpointUrl,
      nativeBedrockProviderAttachment: receipt,
      sandboxCommandExecutor: { runBuffered },
      runOpenshell,
      redact: (value: string) => value,
      beforeSuccess,
    },
  };
}

it("proves the native Bedrock bridge on the recorded gateway using its issued handle", async () => {
  verify.mockReset().mockResolvedValue(undefined);
  const f = fixture();
  await verifyCompatibleEndpointSandboxSmoke(f.options);
  expect(verify).toHaveBeenCalledWith(
    expect.objectContaining({ sandboxName: "selected", expected: f.receipt }),
  );
  expect(f.runOpenshell).not.toHaveBeenCalled();
  expect(f.runBuffered).toHaveBeenCalledWith(
    expect.objectContaining({
      target: { kind: "named", gatewayName: "named-gateway" },
      command: [
        "sh",
        "-lc",
        expect.stringContaining(BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL + "/chat/completions"),
      ],
    }),
  );
  expect(JSON.stringify(f.runBuffered.mock.calls)).toContain(
    "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
  );
  expect(JSON.stringify(f.runBuffered.mock.calls)).not.toContain("inference.local");
  expect(f.beforeSuccess).toHaveBeenCalledOnce();
});
it("refuses a stale generation before executing a sandbox command", async () => {
  verify.mockReset().mockRejectedValue(new Error("adapter generation changed"));
  const f = fixture();
  await expect(verifyCompatibleEndpointSandboxSmoke(f.options)).rejects.toThrow(
    "adapter generation changed",
  );
  expect(f.runBuffered).not.toHaveBeenCalled();
  expect(f.beforeSuccess).not.toHaveBeenCalled();
});

it("awaits the inference response before publishing success and preserves failure", async () => {
  verify.mockReset().mockResolvedValue(undefined);
  const f = fixture();
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<never>((_resolve, reject) => {
    rejectResponse = reject;
  });
  f.runBuffered
    .mockImplementationOnce(async () => ({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "OPENCLAW_NATIVE_CONFIG_OK\n",
      stderr: "",
    }))
    .mockImplementationOnce(() => response);
  const pending = verifyCompatibleEndpointSandboxSmoke(f.options);
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.runBuffered).toHaveBeenCalledTimes(2));
  expect(f.beforeSuccess).not.toHaveBeenCalled();
  rejectResponse(new Error("inference probe failed"));
  await rejection;
  expect(f.beforeSuccess).not.toHaveBeenCalled();
});
