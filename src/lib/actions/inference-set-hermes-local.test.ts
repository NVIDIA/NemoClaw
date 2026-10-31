// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createDeps,
  HERMES_TARGET,
  nativeLocalTestReceipt,
} from "../../../test/helpers/inference-set";
import { switchingFixture } from "../../../test/helpers/inference-set-openclaw-native-local";
import { withNativePolicyFixture } from "../../../test/support/native-local-setup-harness";
import { prepareNativeLocalSwitch } from "./inference/native-local";
import { verifyNativeLocalProviderAttachment } from "../inference/native-local/profile";
import { applyHermesManagedRoute } from "../hermes-managed-route";
import type { SandboxEntry } from "../state/registry";
import { nativeLocalIdentity, type NativeLocalBinding } from "../inference/native-local/contract";
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
function fixture(
  bindingOverride: Partial<NativeLocalBinding> = {},
  entryOverride: Partial<SandboxEntry> = {},
) {
  const binding = { ...nativeLocalTestReceipt(), agent: "hermes" as const, ...bindingOverride };
  const receipt = { ...binding, ...nativeLocalIdentity(binding) };
  const config: ConfigObject = { mcp_servers: { example: { command: "example-mcp" } } };
  applyHermesManagedRoute(config, {
    upstreamProvider: receipt.provider,
    baseUrl: receipt.endpointUrl,
    model: "old-local-model",
    inferenceApi: receipt.api ?? "openai-completions",
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
      ...entryOverride,
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

it.each(["openai-completions", "openai-responses"] as const)(
  "switches Hermes to reserved-alias %s with its selected credential",
  async (api) => {
    const { deps } = switchingFixture(
      {
        agent: "hermes",
        ...(api === "openai-responses" ? { api } : {}),
        provider: "compatible-endpoint",
        authMode: "authenticated",
        endpointUrl: "http://host.openshell.internal:42103/v1",
      },
      [{ agent: "hermes" }],
    );
    deps.getSandbox("alpha")!.agent = "hermes";
    deps.resolveAgentConfig = () => HERMES_TARGET;
    const config: ConfigObject = {};
    applyHermesManagedRoute(config, {
      upstreamProvider: "ollama-local",
      baseUrl: "http://host.openshell.internal:11435/v1",
      model: "old-model",
      inferenceApi: "openai-completions",
      nativeCredentialHandle: issued("v6"),
    });
    deps.calls.readSandboxConfig.mockReturnValue(config);
    deps.prepareNativeLocalSwitch = prepareNativeLocalSwitch;
    deps.verifyNativeLocalProviderAttachment = verifyNativeLocalProviderAttachment;
    deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-host-key");
    const execute = vi.fn<NonNullable<SandboxInferenceInvocationDeps["execute"]>>(async () => ({
      status: 0,
      stdout:
        '200\n{"choices":[{"message":{"content":"OK"}}],"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}',
      stderr: "",
    }));
    deps.calls.probeSandboxRoute.mockImplementation((input) =>
      probeSandboxInferenceInvocation(input, { execute }),
    );
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    await withNativePolicyFixture(() =>
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "served-alias",
          sandboxName: "alpha",
          endpointUrl: "http://host.openshell.internal:42103/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: api,
        },
        deps,
      ),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [{ name: "NEMOCLAW_LOCAL_INFERENCE_TOKEN", value: "fixture-only-host-key" }],
      }),
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        endpointUrl: "http://host.openshell.internal:42103/v1",
        nativeLocalProviderAttachment: expect.objectContaining({
          agent: "hermes",
          provider: "compatible-endpoint",
        }),
      }),
    );
    expect(execute.mock.calls[0][1]).toContain(
      api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions",
    );
    expect(config.model.api_mode ?? null).toBe(
      api === "openai-responses" ? "codex_responses" : null,
    );
    expect(config.model).toMatchObject({
      base_url: "http://host.openshell.internal:42103/v1",
      api_key: issued("v1"),
    });
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => Array.isArray(args) && args[0] === "inference",
      ),
    ).toBe(false);
  },
);

it.each([
  "http://127.0.0.1:11434/v1",
  "http://127.0.0.1:8000/other",
  "http://host.openshell.internal:42103/v1",
])(
  "rejects a Hermes no-auth backend replacement %s before preparing a provider",
  async (endpointUrl) => {
    const { deps, receipt } = fixture();
    const binding = {
      ...receipt,
      provider: "compatible-endpoint" as const,
      authMode: "authenticated" as const,
    };
    Object.assign(deps.getSandbox("alpha")!, {
      provider: "compatible-endpoint",
      endpointUrl: "http://127.0.0.1:8000/v1",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      nativeLocalProviderAttachment: { ...binding, ...nativeLocalIdentity(binding) },
    });
    const prepare = vi.spyOn(deps, "prepareNativeLocalSwitch");
    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "served-alias",
          sandboxName: "alpha",
          endpointUrl,
          inferenceApi: "openai-completions",
        },
        deps,
      ),
    ).rejects.toThrow(/no-auth proxy is bound to the recorded backend/);
    expect(prepare).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  },
);

it.each([undefined, "http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1/"])(
  "reuses authenticated recorded loopback %s through its verified native attachment",
  async (endpointUrl) => {
    const { deps, receipt, config } = fixture(
      {
        provider: "compatible-endpoint",
        endpointUrl: "http://host.openshell.internal:8000/v1",
        authMode: "authenticated",
        api: "openai-responses",
      },
      {
        endpointUrl: "http://127.0.0.1:8000/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-responses",
      },
    );
    deps.prepareNativeLocalSwitch = prepareNativeLocalSwitch;
    deps.verifyNativeLocalProviderAttachment = verifyNativeLocalProviderAttachment;
    const create = vi.spyOn(deps.providerAdapter, "createProvider");
    await withNativePolicyFixture(() =>
      runInferenceSet(
        { provider: "compatible-endpoint", model: "new-model", sandboxName: "alpha", endpointUrl },
        deps,
      ),
    );
    expect(create).not.toHaveBeenCalled();
    expect(deps.calls.resolveCredentialValue).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeLocalProviderAttachment: receipt,
        preferredInferenceApi: "openai-responses",
      }),
    );
    expect(config.model).toMatchObject({
      base_url: "http://host.openshell.internal:8000/v1",
      api_key: issued("v1"),
      api_mode: "codex_responses",
    });
  },
);

it.each([
  { port: 8000, credentialEnv: "COMPATIBLE_API_KEY" },
  { port: 11435, credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN" },
])(
  "changes a recorded Hermes backend to Responses through native port $port",
  async ({ port, credentialEnv }) => {
    const endpointUrl = `http://host.openshell.internal:${port}/v1`;
    const { deps, next } = switchingFixture(
      {
        agent: "hermes",
        provider: "compatible-endpoint",
        endpointUrl,
        authMode: "authenticated",
        api: "openai-responses",
      },
      [
        {
          agent: "hermes",
          provider: "compatible-endpoint",
          endpointUrl,
          authMode: "authenticated",
        },
        credentialEnv,
        "http://127.0.0.1:8000/v1",
      ],
    );
    deps.getSandbox("alpha")!.agent = "hermes";
    deps.resolveAgentConfig = () => HERMES_TARGET;
    const config: ConfigObject = {};
    applyHermesManagedRoute(config, {
      upstreamProvider: "compatible-endpoint",
      baseUrl: endpointUrl,
      model: "old-model",
      inferenceApi: "openai-completions",
      nativeCredentialHandle: issued("v6"),
    });
    deps.calls.readSandboxConfig.mockReturnValue(config);
    deps.prepareNativeLocalSwitch = prepareNativeLocalSwitch;
    deps.verifyNativeLocalProviderAttachment = verifyNativeLocalProviderAttachment;
    deps.calls.resolveCredentialValue.mockReturnValue("fixture-only-selected-token");
    await withNativePolicyFixture(() =>
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          sandboxName: "alpha",
          endpointUrl: "http://127.0.0.1:8000/v1",
          inferenceApi: "openai-responses",
        },
        deps,
      ),
    );
    expect(deps.calls.resolveCredentialValue).toHaveBeenCalledWith(credentialEnv);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeLocalProviderAttachment: next,
        preferredInferenceApi: "openai-responses",
        credentialEnv,
      }),
    );
    expect(config.model).toMatchObject({
      base_url: endpointUrl,
      api_key: issued("v1"),
      api_mode: "codex_responses",
    });
  },
);

it("rejects a new Hermes raw loopback route before creating a provider", async () => {
  const { deps } = fixture();
  deps.prepareNativeLocalSwitch = prepareNativeLocalSwitch;
  const create = vi.spyOn(deps.providerAdapter, "createProvider");
  await withNativePolicyFixture(() =>
    expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "new-model",
          sandboxName: "alpha",
          endpointUrl: "http://127.0.0.1:8000/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "openai-responses",
        },
        deps,
      ),
    ).rejects.toThrow(/Invalid native host-local inference boundary/),
  );
  expect(create).not.toHaveBeenCalled();
  expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
});
