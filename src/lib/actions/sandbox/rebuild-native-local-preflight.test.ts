// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerPolicy from "../../adapters/openshell/provider-policy";
import * as managedProvider from "../../adapters/openshell/managed-provider-adapter";
import { createCliOpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter-cli";
import {
  nativeLocalIdentity,
  type NativeLocalBinding,
  type NativeLocalProviderAttachment,
} from "../../inference/native-local/contract";
import * as registry from "../../state/registry";
import { preflightRebuildCredentials } from "./rebuild-credential-preflight";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import {
  checkRebuildGatewayCredentialReuseOrBail,
  verifyRebuildNativeLocalProvider,
} from "./rebuild-provider-preflight";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

function fixture(agent: "hermes" | null) {
  const binding: NativeLocalBinding = {
    provider: "compatible-endpoint",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    authMode: "authenticated",
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
    ...(agent ? { agent } : {}),
  };
  const receipt: NativeLocalProviderAttachment = {
    ...binding,
    ...nativeLocalIdentity(binding),
    schemaVersion: 1,
    providerId: "owned-provider-id",
  };
  const adapter = createCliOpenShellProviderAdapter();
  vi.spyOn(providerPolicy, "requireNativeProviderPolicy").mockResolvedValue();
  const profile = vi.spyOn(adapter, "inspectProviderProfile").mockResolvedValue({
    ok: true,
    value: { credentialKeys: [binding.credentialEnv] },
  });
  const metadata = {
    name: receipt.providerName,
    type: receipt.profileId,
    credentialKeys: [binding.credentialEnv],
    configKeys: [],
    revision: { id: receipt.providerId, resourceVersion: 1 },
  };
  const provider = vi
    .spyOn(adapter, "getProvider")
    .mockResolvedValue({ ok: true, value: metadata });
  const attachments = vi.spyOn(adapter, "listProviderAttachments").mockResolvedValue({
    ok: true,
    value: { names: [receipt.providerName] },
  });
  const mutations = [
    "createProvider",
    "updateProvider",
    "attachProvider",
    "deleteProvider",
    "importProviderProfile",
  ] as const;
  const writes = mutations.map((method) => vi.spyOn(adapter, method));
  vi.spyOn(managedProvider, "createManagedProviderAdapter").mockReturnValue(adapter);
  const selection: RebuildResumeConfig = {
    agent,
    provider: binding.provider,
    endpointUrl: binding.endpointUrl,
    model: "activation-test-model",
    credentialEnv: "COMPATIBLE_API_KEY",
    nativeLocalProviderAttachment: receipt,
    preferredInferenceApi: "openai-completions",
    nimContainer: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    pinEndpoint: true,
    registryInferenceRoute: null,
    ambient: { presentVars: [], agentMismatch: null },
  };
  return { adapter, receipt, selection, provider, metadata, profile, attachments, writes };
}

function rebindReceipt(
  receipt: NativeLocalProviderAttachment,
  overrides: Partial<NativeLocalBinding>,
): NativeLocalProviderAttachment {
  const binding = { ...receipt, ...overrides };
  return { ...binding, ...nativeLocalIdentity(binding) };
}

const bail = (message: string): never => {
  throw new Error(message);
};
afterEach(() => vi.restoreAllMocks());

describe("native local rebuild credential authority", () => {
  it("preserves the exact published Pi shared route while rejecting unrecorded or changed selections", async () => {
    const f = fixture(null);
    const selection = { ...f.selection, agent: "pi", nativeLocalProviderAttachment: undefined };
    const recorded = { name: "alpha", ...selection, createdAt: "2026-10-15T00:00:00.000Z" };
    vi.spyOn(registry, "getSandbox").mockReturnValue(recorded);
    await expect(verifyRebuildNativeLocalProvider("alpha", selection)).resolves.toBe(false);
    await expect(
      verifyRebuildNativeLocalProvider("alpha", { ...selection, model: "foreign" }),
    ).rejects.toThrow("Could not verify");
    vi.mocked(registry.getSandbox).mockReturnValue(null);
    await expect(verifyRebuildNativeLocalProvider("alpha", selection)).rejects.toThrow(
      "Could not verify",
    );
    expect(f.provider).not.toHaveBeenCalled();
  });

  it.each([null, "hermes"] as const)(
    "uses the attached provider at initial, reuse, and delete-edge preflight for %s",
    async (agent) => {
      const f = fixture(agent);
      const hydrate = vi
        .spyOn(rebuildOnboardDependencies, "hydrateCredentialEnv")
        .mockImplementation(() => {
          throw new Error("Native local preflight must not read host credentials");
        });
      await expect(
        preflightRebuildCredentials(
          {
            name: "alpha",
            gatewayName: "nemoclaw",
            ...f.selection,
          },
          vi.fn(),
          bail,
        ),
      ).resolves.toBe(true);
      await expect(
        checkRebuildGatewayCredentialReuseOrBail("alpha", f.selection, false, vi.fn(), bail),
      ).resolves.toBe(true);
      await expect(
        verifyRebuildNativeLocalProvider("alpha", f.selection, {
          gatewayName: "nemoclaw",
          workspace: "nemoclaw",
        }),
      ).resolves.toBe(true);
      expect(hydrate).not.toHaveBeenCalled();
      expect(f.provider).toHaveBeenCalledTimes(3);
      expect(
        f.provider.mock.calls.every(
          ([request]) =>
            request.providerName === f.receipt.providerName &&
            request.target.kind === "named" &&
            request.target.gatewayName === "nemoclaw",
        ),
      ).toBe(true);
      expect(f.attachments).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      });
      expect(f.writes.map((write) => write.mock.calls)).toEqual([[], [], [], [], []]);
    },
  );

  it.each([
    ["missing", (_receipt: NativeLocalProviderAttachment): undefined => undefined],
    [
      "tampered",
      (receipt: NativeLocalProviderAttachment) => ({
        ...receipt,
        providerName: "foreign-provider",
      }),
    ],
    [
      "foreign-sandbox",
      (receipt: NativeLocalProviderAttachment) =>
        rebindReceipt(receipt, { sandboxName: "sibling" }),
    ],
    [
      "foreign-gateway",
      (receipt: NativeLocalProviderAttachment) =>
        rebindReceipt(receipt, { gatewayName: "foreign" }),
    ],
    [
      "foreign-agent",
      (receipt: NativeLocalProviderAttachment) => rebindReceipt(receipt, { agent: undefined }),
    ],
    [
      "foreign-endpoint",
      (receipt: NativeLocalProviderAttachment) =>
        rebindReceipt(receipt, { endpointUrl: "http://host.openshell.internal:8000/other" }),
    ],
  ] as const)("rejects %s ownership before reading any provider", async (_name, change) => {
    const f = fixture("hermes");
    await expect(
      verifyRebuildNativeLocalProvider("alpha", {
        ...f.selection,
        gatewayName: "nemoclaw",
        nativeLocalProviderAttachment: change(f.receipt),
      }),
    ).rejects.toThrow("Could not verify the recorded native local provider attachment");
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.writes.map((write) => write.mock.calls)).toEqual([[], [], [], [], []]);
  });

  it.each([
    [
      "missing-provider",
      (f: ReturnType<typeof fixture>) =>
        f.provider.mockResolvedValue({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "secret diagnostic" },
        }),
    ],
    [
      "replaced-provider",
      (f: ReturnType<typeof fixture>) =>
        f.provider.mockResolvedValue({
          ok: true,
          value: { ...f.metadata, revision: { id: "replacement", resourceVersion: 2 } },
        }),
    ],
    [
      "detached",
      (f: ReturnType<typeof fixture>) =>
        f.attachments.mockResolvedValue({ ok: true, value: { names: [] } }),
    ],
    [
      "changed-profile",
      (f: ReturnType<typeof fixture>) =>
        f.profile.mockRejectedValue(new Error("secret diagnostic")),
    ],
    [
      "wrong-credential",
      (f: ReturnType<typeof fixture>) =>
        f.provider.mockResolvedValue({
          ok: true,
          value: { ...f.metadata, credentialKeys: ["COMPATIBLE_API_KEY"] },
        }),
    ],
    [
      "policy-unavailable",
      (_f: ReturnType<typeof fixture>) =>
        vi
          .mocked(providerPolicy.requireNativeProviderPolicy)
          .mockRejectedValue(new Error("secret diagnostic")),
    ],
  ] as const)("fails closed when current authority is %s", async (_name, change) => {
    const f = fixture("hermes");
    change(f);
    await expect(
      checkRebuildGatewayCredentialReuseOrBail("alpha", f.selection, true, vi.fn(), bail),
    ).rejects.toThrow(
      /^Could not verify the recorded native local provider attachment; sandbox is untouched\.$/,
    );
    expect(f.writes.map((write) => write.mock.calls)).toEqual([[], [], [], [], []]);
  });

  it("detects a provider replacement at the delete edge after successful preflight", async () => {
    const f = fixture(null);
    await expect(verifyRebuildNativeLocalProvider("alpha", f.selection)).resolves.toBe(true);
    f.provider.mockResolvedValue({
      ok: true,
      value: { ...f.metadata, revision: { id: "replaced-after-backup", resourceVersion: 2 } },
    });
    await expect(
      verifyRebuildNativeLocalProvider("alpha", f.selection, {
        gatewayName: "nemoclaw",
        workspace: "nemoclaw",
      }),
    ).rejects.toThrow("Could not verify");
    await expect(
      verifyRebuildNativeLocalProvider("alpha", f.selection, {
        gatewayName: "foreign",
        workspace: "nemoclaw",
      }),
    ).rejects.toThrow("Could not verify");
  });
});
