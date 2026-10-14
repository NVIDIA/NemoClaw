// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import {
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  ensureNativeNvidiaProvider,
  nativeNvidiaProviderAttachmentFromMetadata,
} from "./native-nvidia";
import { ensureNativeLocalProvider } from "./native-local/profile";

const target = { kind: "named", gatewayName: "selected" } as const;
const metadata: OpenShellProviderMetadata = {
  name: NVIDIA_HOSTED_NATIVE_PROVIDER,
  type: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  credentialKeys: [NVIDIA_HOSTED_CREDENTIAL_ENV],
  configKeys: [],
  revision: { id: "owned", resourceVersion: 1 },
};
function fixture(existing = false) {
  let provider: OpenShellProviderMetadata | undefined = existing ? metadata : undefined;
  const adapter = {
    importProviderProfile: vi.fn(async () => ({ ok: true as const })),
    getProvider: vi.fn(async () =>
      provider
        ? { ok: true as const, value: provider }
        : {
            ok: false as const,
            error: { kind: "command" as const, reason: "not_found" as const, message: "absent" },
          },
    ),
    ensureProviderPolicyComposition: vi.fn<
      OpenShellProviderAdapter["ensureProviderPolicyComposition"]
    >(async () => ({ ok: true, value: undefined })),
    createProvider: vi.fn<OpenShellProviderAdapter["createProvider"]>(async (request) => {
      provider = {
        ...metadata,
        name: request.name,
        type: request.type,
        credentialKeys: request.credentials.map((c) => c.name),
      };
      return { ok: true };
    }),
    updateProvider: vi.fn(async () => ({ ok: true as const })),
  };
  return { adapter, transport: adapter as unknown as OpenShellProviderAdapter };
}
function localFixture(enabled: "true" | "false") {
  const f = fixture();
  const policyCommand = vi.fn(async (args: string[]) => ({
    status: 0,
    stdout:
      args[0] === "settings"
        ? JSON.stringify({ scope: "global", settings: { providers_v2_enabled: enabled } })
        : "",
    stderr: args[0] === "settings" ? "" : "No global policy history found",
  }));
  const action = ensureNativeLocalProvider({
    adapter: f.transport,
    binding: {
      provider: "vllm-local",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      authMode: "sentinel",
      gatewayName: "selected",
      sandboxName: "alice",
    },
    credentialValue: "test-key",
    policyCommand,
    readAuthority: () => undefined,
    writeAuthority: vi.fn(),
  });
  return { f, policyCommand, action };
}
describe("native provider policy ownership", () => {
  it("activates NVIDIA composition before creating the validated provider (#12558)", async () => {
    const f = fixture();
    await ensureNativeNvidiaProvider({ adapter: f.transport, target, credentialValue: "test-key" });
    expect(f.adapter.ensureProviderPolicyComposition).toHaveBeenCalledExactlyOnceWith({ target });
    expect(f.adapter.getProvider.mock.invocationCallOrder[0]).toBeLessThan(
      f.adapter.ensureProviderPolicyComposition.mock.invocationCallOrder[0]!,
    );
    expect(f.adapter.ensureProviderPolicyComposition.mock.invocationCallOrder[0]).toBeLessThan(
      f.adapter.createProvider.mock.invocationCallOrder[0]!,
    );
  });
  it("activates NVIDIA composition when reusing owned credentials (#12558)", async () => {
    const f = fixture(true);
    const expected = nativeNvidiaProviderAttachmentFromMetadata(metadata);
    await expect(
      ensureNativeNvidiaProvider({ adapter: f.transport, target, expected, credentialValue: null }),
    ).resolves.toEqual(expected);
    expect(f.adapter.ensureProviderPolicyComposition).toHaveBeenCalledOnce();
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  });
  it("rejects unowned NVIDIA providers without activating composition (#12558)", async () => {
    const f = fixture(true);
    await expect(
      ensureNativeNvidiaProvider({ adapter: f.transport, target, credentialValue: "test-key" }),
    ).rejects.toThrow("ownership receipt");
    expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
  });
  it("rejects missing NVIDIA credentials without activating composition (#12558)", async () => {
    const f = fixture();
    await expect(
      ensureNativeNvidiaProvider({ adapter: f.transport, target, credentialValue: null }),
    ).rejects.toThrow("host credential");
    expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
  });
  it("stops NVIDIA creation when composition activation fails (#12558)", async () => {
    const f = fixture();
    f.adapter.ensureProviderPolicyComposition.mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "failed", message: "denied" },
    });
    await expect(
      ensureNativeNvidiaProvider({ adapter: f.transport, target, credentialValue: "test-key" }),
    ).rejects.toThrow("activate native NVIDIA provider policy");
    expect(f.adapter.createProvider).not.toHaveBeenCalled();
  });
  it("keeps enabled native-local composition read-only (#12558)", async () => {
    const { f, policyCommand, action } = localFixture("true");
    await expect(action).resolves.toMatchObject({ sandboxName: "alice" });
    expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
    expect(policyCommand.mock.calls.some(([args]) => args.includes("set"))).toBe(false);
  });
  it("rejects disabled native-local composition without activating it (#12558)", async () => {
    const { f, policyCommand, action } = localFixture("false");
    await expect(action).rejects.toThrow("administrator");
    expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
    expect(policyCommand.mock.calls.some(([args]) => args.includes("set"))).toBe(false);
  });
});
