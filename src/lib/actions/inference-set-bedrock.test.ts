// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { nativeBedrockSwitchFixture } from "../inference/native-bedrock/switch.test-support";
import { runInferenceSet } from "./inference-set";
import { createDeps, HERMES_TARGET } from "./inference-set.test-support";

function fixture() {
  const f = nativeBedrockSwitchFixture();
  const deps = createDeps({
    config: {
      agents: { defaults: { model: { primary: "inference/old-model" } } },
      models: { providers: { inference: { api: "anthropic-messages" } } },
    },
    providerAdapter: f.providerAdapter,
    entry: {
      name: "alpha",
      agent: "openclaw",
      provider: "compatible-anthropic-endpoint",
      model: "old-model",
      gatewayName: f.receipt.gatewayName,
      endpointUrl: f.receipt.endpointUrl,
      preferredInferenceApi: "openai-completions",
      nativeBedrockProviderAttachment: f.receipt,
    },
    session: null,
  });
  const verify = vi.fn(async () => {});
  deps.verifyBedrockAdapterGeneration = verify;
  deps.ensureBedrockRuntimeAdapter = vi.fn();
  deps.clearNativeBedrockProviderAuthority = vi.fn();
  const sharedRoute = vi.spyOn(deps.inferenceRouteMutator, "setInferenceRoute");
  const run = () =>
    runInferenceSet(
      {
        sandboxName: "alpha",
        provider: "compatible-anthropic-endpoint",
        model: "new-model",
        noVerify: true,
      },
      deps,
    );
  return { ...f, deps, verify, sharedRoute, run };
}

describe("native Bedrock inference selection", () => {
  it("requires recreation of a legacy Bedrock sandbox without mutating its route", async () => {
    const f = fixture();
    Object.assign(f.deps.getSandbox("alpha")!, { nativeBedrockProviderAttachment: undefined });
    await expect(f.run()).rejects.toThrow(
      "Recreate this beta sandbox before switching native Bedrock inference",
    );
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.deps.ensureBedrockRuntimeAdapter).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.sharedRoute).not.toHaveBeenCalled();
  });

  it("preserves a Bedrock provider reserved by a pending peer", async () => {
    const f = fixture();
    const selected = f.deps.getSandbox("alpha")!;
    f.deps.listSandboxes = () => ({
      defaultSandbox: "alpha",
      sandboxes: [selected, { ...selected, name: "pending-peer", pendingRouteReservation: true }],
    });
    await runInferenceSet(
      { sandboxName: "alpha", provider: "openai", model: "gpt-4o", noVerify: true },
      f.deps,
    );
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
  });
  it("keeps Hermes on the native adapter when changing models", async () => {
    const f = fixture();
    Object.assign(f.deps.getSandbox("alpha")!, { agent: "hermes" });
    f.deps.resolveAgentConfig = () => HERMES_TARGET;
    f.deps.calls.readSandboxConfig.mockReturnValue({
      model: { default: "old-model", provider: "custom", api_key: "unused" },
    });
    await f.run();
    expect(f.sharedRoute).not.toHaveBeenCalled();
    expect(f.deps.calls.writeSandboxConfig).toHaveBeenCalled();
    const writes = JSON.stringify(f.deps.calls.writeSandboxConfig.mock.calls);
    expect(writes).toContain(f.receipt.adapterBaseUrl);
    expect(writes).toContain("${NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN}");
    expect(writes).not.toContain("inference.local");
  });
  it("creates scoped Bedrock access when switching from OpenAI", async () => {
    const f = fixture();
    Object.assign(f.deps.getSandbox("alpha")!, {
      provider: "openai-api",
      endpointUrl: undefined,
      nativeBedrockProviderAttachment: undefined,
    });
    f.attachments.clear();
    f.adapter.getProvider.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "not_found", message: "absent" },
    });
    f.deps.resolveCredentialValue = vi.fn(() => "test-aws-credential");
    f.deps.getNativeBedrockProviderAuthority = vi.fn(() => undefined);
    f.deps.setNativeBedrockProviderAuthority = vi.fn();
    f.deps.ensureBedrockRuntimeAdapter = vi.fn(async () => ({
      baseUrl: f.receipt.adapterBaseUrl,
      localBaseUrl: "http://127.0.0.1:11436/v1",
      logPath: "/unused-test-log",
      credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
      token: "test-adapter-token",
      region: f.receipt.region,
      endpointUrl: f.receipt.endpointUrl,
      generation: f.receipt.adapterGeneration,
    }));
    await runInferenceSet(
      {
        sandboxName: "alpha",
        provider: "compatible-anthropic-endpoint",
        model: "new-model",
        endpointUrl: f.receipt.endpointUrl,
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        inferenceApi: "openai-completions",
        noVerify: true,
      },
      f.deps,
    );
    expect(f.adapter.createProvider).toHaveBeenCalledOnce();
    expect(f.adapter.attachProvider).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
    );
    expect(f.sharedRoute).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeBedrockProviderAttachment: f.receipt,
        endpointUrl: f.receipt.endpointUrl,
        preferredInferenceApi: "openai-completions",
      }),
    );
    expect(JSON.stringify(f.deps.calls.updateSandbox.mock.calls)).not.toContain(
      "test-adapter-token",
    );
  });
  it("retains provider ownership when another sandbox still uses Bedrock", async () => {
    const f = fixture();
    f.adapter.deleteProvider.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "attached", message: "peer attached" },
    });
    await runInferenceSet(
      { sandboxName: "alpha", provider: "openai", model: "gpt-4o", noVerify: true },
      f.deps,
    );
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.detachProvider).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "alpha" }),
    );
    expect(f.adapter.deleteProvider).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: f.receipt.gatewayName },
      providerName: f.receipt.providerName,
    });
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
  });
  it("clears the Bedrock receipt and retires its provider after switching away", async () => {
    const f = fixture();
    await runInferenceSet(
      { sandboxName: "alpha", provider: "openai", model: "gpt-4o", noVerify: true },
      f.deps,
    );
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.deleteProvider).toHaveBeenCalledOnce();
    expect(f.deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "openai-api",
        nativeBedrockProviderAttachment: undefined,
      }),
    );
    expect(f.deps.clearNativeBedrockProviderAuthority).toHaveBeenCalledWith(
      f.receipt.gatewayName,
      f.receipt,
    );
  });
  it("restores Bedrock access when the new selection cannot be recorded", async () => {
    const f = fixture();
    f.deps.calls.updateSandbox.mockReturnValue(false);
    await expect(
      runInferenceSet(
        { sandboxName: "alpha", provider: "openai", model: "gpt-4o", noVerify: true },
        f.deps,
      ),
    ).rejects.toThrow("Failed to update NemoClaw registry");
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(f.attachments.has(f.receipt.providerName)).toBe(true);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.deps.clearNativeBedrockProviderAuthority).not.toHaveBeenCalled();
  });
  it("reuses the verified adapter generation without shared route mutation", async () => {
    const f = fixture();
    await f.run();
    expect(f.verify).toHaveBeenCalledWith(f.receipt);
    expect(f.deps.ensureBedrockRuntimeAdapter).not.toHaveBeenCalled();
    expect(f.sharedRoute).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        model: "new-model",
        nativeBedrockProviderAttachment: f.receipt,
        preferredInferenceApi: "openai-completions",
      }),
    );
    expect(f.deps.calls.setOpenClawConfigValues).toHaveBeenCalled();
  });
  it("refuses stale adapter generation before publishing a new model", async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new Error("stale generation"));
    await expect(f.run()).rejects.toThrow("stale generation");
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.sharedRoute).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });
  it("removes only the newly attached access when sandbox verification fails", async () => {
    const f = fixture();
    f.attachments.clear();
    f.deps.probeSandboxRoute = vi.fn(async () => ({
      ok: false,
      detail: "denied",
      httpStatus: 403,
    }));
    await expect(f.run()).rejects.toThrow("Sandbox-side verification rejected");
    expect(f.adapter.attachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.attachments.size).toBe(0);
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(f.sharedRoute).not.toHaveBeenCalled();
  });
  it("rejects unsupported Bedrock protocols before attaching or starting adapters", async () => {
    const f = fixture();
    await expect(
      runInferenceSet(
        {
          sandboxName: "alpha",
          provider: "compatible-anthropic-endpoint",
          model: "new-model",
          inferenceApi: "anthropic-messages",
          endpointUrl: f.receipt.endpointUrl,
        },
        f.deps,
      ),
    ).rejects.toThrow("OpenAI-compatible frontend");
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.deps.ensureBedrockRuntimeAdapter).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.deps.calls.updateSandbox).not.toHaveBeenCalled();
  });
});
