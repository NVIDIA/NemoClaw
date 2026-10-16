// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createDeps,
  HERMES_TARGET,
  nativeLocalTestReceipt,
} from "../../../test/helpers/inference-set";
import { applyHermesManagedRoute } from "../hermes-managed-route";
import { nativeLocalIdentity } from "../inference/native-local/contract";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import {
  probeSandboxInferenceInvocation,
  type SandboxInferenceInvocationDeps,
} from "./sandbox/inference-invocation-probe";

const issued = (scope: string) => `openshell:resolve:env:${scope}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`;
const selection = {
  provider: "ollama-local",
  model: "new-local-model",
  sandboxName: "alpha",
  noVerify: true,
};
function fixture() {
  const binding = { ...nativeLocalTestReceipt(), agent: "hermes" as const };
  const receipt = { ...binding, ...nativeLocalIdentity(binding) };
  const config: ConfigObject = { mcp_servers: { example: { command: "example-mcp" } } };
  applyHermesManagedRoute(config, {
    upstreamProvider: receipt.provider,
    baseUrl: receipt.endpointUrl,
    model: "old-local-model",
    inferenceApi: "openai-completions",
    nativeCredentialHandle: issued("v6"),
  });
  const deps = createDeps({
    config,
    entry: {
      name: "alpha",
      agent: "hermes",
      provider: receipt.provider,
      model: "old-local-model",
      endpointUrl: receipt.endpointUrl,
      nativeLocalProviderAttachment: receipt,
    },
    defaultSandbox: "alpha",
    target: HERMES_TARGET,
  });
  return { config, receipt, deps };
}

function preparedAttachmentFixture() {
  const f = fixture();
  const entry = f.deps.getSandbox("alpha")!;
  entry.provider = "hermes-provider";
  delete entry.nativeLocalProviderAttachment;
  delete entry.endpointUrl;
  f.deps.calls.updateSandbox.mockImplementation((name: string, updates: object) => {
    Object.assign(f.deps.getSandbox(name)!, updates);
    return true;
  });
  applyHermesManagedRoute(f.config, {
    upstreamProvider: "hermes-provider",
    model: "old-model",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    inferenceApi: "openai-completions",
  });
  vi.spyOn(f.deps, "prepareNativeLocalSwitch").mockResolvedValue({
    receipt: f.receipt,
    changed: true,
    previousDetached: false,
  });
  const attached = new Set([f.receipt.providerName]);
  const detach = vi.fn(async () => ({
    ok: true as const,
    value: { changed: attached.delete(f.receipt.providerName) },
  }));
  f.deps.providerAdapter = {
    ...f.deps.providerAdapter,
    inspectProviderProfile: async () => ({
      ok: true,
      value: { credentialKeys: [f.receipt.credentialEnv] },
    }),
    getProvider: async () => ({
      ok: true,
      value: {
        name: f.receipt.providerName,
        type: f.receipt.profileId,
        credentialKeys: [f.receipt.credentialEnv],
        configKeys: [],
        revision: { id: f.receipt.providerId, resourceVersion: 1 },
      },
    }),
    listProviderAttachments: async () => ({ ok: true, value: { names: [...attached] } }),
    detachProvider: detach,
  };
  return { ...f, detach, attached };
}

describe("Hermes native local selection", () => {
  it("verifies a model switch against the attached local endpoint before publication", async () => {
    const { deps, receipt } = fixture();
    const execute = vi.fn<NonNullable<SandboxInferenceInvocationDeps["execute"]>>(async () => ({
      status: 0,
      stdout: '200\n{"choices":[{"message":{"content":"OK"}}]}',
      stderr: "",
    }));
    deps.calls.probeSandboxRoute.mockImplementation((input) =>
      probeSandboxInferenceInvocation(input, { execute }),
    );

    await runInferenceSet(selection, deps);

    expect(execute).toHaveBeenCalledOnce();
    const command = execute.mock.calls[0][1];
    expect(command).toContain(`'${receipt.endpointUrl}/chat/completions'`);
    expect(command).not.toContain("inference.local");
    expect(command).toContain(`"model":"${selection.model}"`);
    expect(command).toContain(
      'AUTH_HEADER="Authorization: Bearer ${NEMOCLAW_LOCAL_INFERENCE_TOKEN}"',
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.updateSandbox.mock.invocationCallOrder[0],
    );
  });

  it.each(["v7", "v8", `s${"b".repeat(64)}`])(
    "refreshes all managed slots from %s before publishing and restarts Hermes",
    async (scope) => {
      const { config, receipt, deps } = fixture();
      const read = vi
        .spyOn(deps, "readNativeLocalCredentialHandle")
        .mockResolvedValue(issued(scope));
      const verify = vi.spyOn(deps, "verifyNativeLocalProviderAttachment");
      const result = await runInferenceSet(selection, deps);
      expect(result.inSandboxConfigSynced).toBe(true);
      expect(read).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
      expect(verify).toHaveBeenCalledExactlyOnceWith({
        adapter: deps.providerAdapter,
        sandboxName: "alpha",
        expected: receipt,
      });
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(verify.mock.invocationCallOrder[0]);
      expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
        deps.calls.updateSandbox.mock.invocationCallOrder[0],
      );
      expect(config.model.api_key).toBe(issued(scope));
      expect(config.providers[receipt.provider].api_key).toBe(issued(scope));
      expect(config.custom_providers[0].api_key).toBe(issued(scope));
      expect(config.mcp_servers).toEqual({ example: { command: "example-mcp" } });
      expect(deps.calls.restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
      expect(deps.calls.resolveCredentialValue).not.toHaveBeenCalled();
    },
  );

  it("leaves durable selection and config unchanged when the issued reference is missing", async () => {
    const { config, deps } = fixture();
    const original = structuredClone(config);
    vi.spyOn(deps, "readNativeLocalCredentialHandle").mockRejectedValue(
      new Error("issued reference unavailable"),
    );
    await expect(runInferenceSet(selection, deps)).rejects.toThrow("issued reference unavailable");
    expect(config).toEqual(original);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("refuses publication when the attachment changes during the credential read", async () => {
    const { config, deps } = fixture();
    const original = structuredClone(config);
    vi.spyOn(deps, "verifyNativeLocalProviderAttachment").mockRejectedValue(
      new Error("attachment ownership changed"),
    );
    await expect(runInferenceSet(selection, deps)).rejects.toThrow("attachment ownership changed");
    expect(config).toEqual(original);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
  });

  it("rejects another consumer's local receipt before reading or publishing credentials", async () => {
    const { deps } = fixture();
    deps.getSandbox("alpha")!.nativeLocalProviderAttachment = nativeLocalTestReceipt();
    await expect(runInferenceSet(selection, deps)).rejects.toThrow("does not authorize Hermes");
    expect(deps.readNativeLocalCredentialHandle).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  describe.each(["ollama-local", "hermes-provider"])("switching to %s", (provider) => {
    it.each([
      { label: "foreign gateway", binding: { gatewayName: "other-gateway" } },
      { label: "sibling sandbox", binding: { sandboxName: "other-sandbox" } },
      { label: "different recorded provider", binding: { provider: "vllm-local" as const } },
      { label: "malformed identity", invalid: { providerName: "invalid-provider" } },
      { label: "malformed receipt", invalid: { schemaVersion: 2 } },
      { label: "null receipt", nullReceipt: true },
    ])("rejects a $label before provider operations", async (scenario) => {
      const { config, receipt, deps } = fixture();
      const binding = { ...receipt, ...scenario.binding };
      Object.assign(deps.getSandbox("alpha")!, {
        nativeLocalProviderAttachment: scenario.nullReceipt
          ? null
          : { ...binding, ...nativeLocalIdentity(binding), ...scenario.invalid },
      });
      const original = structuredClone(config);
      const policy = vi.spyOn(deps, "requireNativeProviderPolicy");
      const prepare = vi.spyOn(deps, "prepareNativeLocalSwitch");
      await expect(runInferenceSet({ ...selection, provider }, deps)).rejects.toThrow(
        "The recorded local provider attachment does not match this sandbox's selection",
      );
      expect(policy).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(deps.readNativeLocalCredentialHandle).not.toHaveBeenCalled();
      expect(deps.verifyNativeLocalProviderAttachment).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
      expect(config).toEqual(original);
    });
  });

  it("retains committed attachment authority when the guarded config write fails", async () => {
    const { deps, receipt, detach } = preparedAttachmentFixture();
    deps.calls.writeSandboxConfig.mockImplementationOnce(() => {
      throw new Error("guarded write failed");
    });
    await expect(runInferenceSet(selection, deps)).rejects.toThrow(
      "synchronization did not complete",
    );
    expect(deps.getSandbox("alpha")).toMatchObject({
      provider: selection.provider,
      model: selection.model,
      nativeLocalProviderAttachment: receipt,
    });
    expect(detach).not.toHaveBeenCalled();
  });

  it("observes committed authority after an ambiguous registry write before compensation", async () => {
    const { deps, receipt, detach } = preparedAttachmentFixture();
    deps.calls.updateSandbox.mockImplementationOnce((name: string, updates: object) => {
      Object.assign(deps.getSandbox(name)!, updates);
      throw new Error("ambiguous registry write");
    });
    await expect(runInferenceSet(selection, deps)).rejects.toThrow("ambiguous registry write");
    expect(deps.getSandbox("alpha")).toMatchObject({
      model: selection.model,
      nativeLocalProviderAttachment: receipt,
    });
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it("detaches newly granted access when the reference read fails before publication", async () => {
    const { deps, receipt, detach, attached } = preparedAttachmentFixture();
    vi.spyOn(deps, "readNativeLocalCredentialHandle").mockRejectedValue(
      new Error("issued reference unavailable"),
    );
    await expect(runInferenceSet(selection, deps)).rejects.toThrow("issued reference unavailable");
    expect(detach).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      sandboxName: "alpha",
      providerName: receipt.providerName,
    });
    expect(attached.size).toBe(0);
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });
});
