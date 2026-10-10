// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/provider-adapter";
import { buildNativeCustomProfile } from "./profile";
import { buildHttpsPinRouteBaseUrl, computeHttpsPinRouteId } from "../https-pin-runtime";
import type { NativeCustomProfile } from "./index";
import { prepareNativeCustomProfile, customAttachmentFromPrepared } from "./index";
import { retireNativeCustomProviders } from "./cleanup";

async function fixture(selected?: NativeCustomProfile) {
  const prepared =
    selected ??
    (await prepareNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl: "http://8.8.8.8/v1",
      api: "openai-completions",
    }));
  const receipt = customAttachmentFromPrepared(prepared, {
    schemaVersion: 1,
    profileId: prepared.profile.id,
    providerName: prepared.providerName,
    providerId: "owned-id",
  });
  let metadata: OpenShellProviderMetadata | null = {
    name: receipt.providerName,
    type: receipt.profileId,
    credentialKeys: [receipt.credentialEnv],
    configKeys: [],
    revision: { id: receipt.providerId, resourceVersion: 1 },
  };
  const adapter = {
    getProvider: vi.fn(async () =>
      metadata
        ? { ok: true, value: metadata }
        : { ok: false, error: { kind: "command", reason: "not_found", message: "missing" } },
    ),
    deleteProvider: vi.fn(async () => {
      metadata = null;
      return { ok: true };
    }),
    detachProvider: vi.fn(),
  } as unknown as OpenShellProviderAdapter;
  const clear = vi.fn();
  const input = {
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
    receipts: [receipt],
    adapter,
    clearAuthority: clear,
  };
  return {
    input,
    receipt,
    adapter,
    clear,
    replaceIdentity: () => {
      metadata = { ...metadata!, revision: { id: "replacement-id", resourceVersion: 2 } };
    },
  };
}

it("deletes only the immutable owned provider and clears authority after absence is observed (#12636)", async () => {
  const f = await fixture();
  await retireNativeCustomProviders(f.input);
  expect(f.adapter.deleteProvider).toHaveBeenCalledWith({
    target: { kind: "named", gatewayName: "nemoclaw" },
    providerName: f.receipt.providerName,
  });
  expect(f.adapter.getProvider).toHaveBeenCalledTimes(2);
  expect(f.clear).toHaveBeenCalledWith("nemoclaw", f.receipt);
  expect(f.adapter.detachProvider).not.toHaveBeenCalled();
});

it("refuses replacement identity without deleting or clearing recovery authority (#12636)", async () => {
  const f = await fixture();
  f.replaceIdentity();
  await expect(retireNativeCustomProviders(f.input)).rejects.toThrow("identity changed");
  expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  expect(f.clear).not.toHaveBeenCalled();
});

it("preserves attached peer access and recovery authority when OpenShell refuses deletion (#12636)", async () => {
  const f = await fixture();
  vi.mocked(f.adapter.deleteProvider).mockResolvedValue({
    ok: false,
    error: {
      kind: "command",
      reason: "attached",
      attachedSandboxes: ["peer"],
      message: "attached",
    },
  });
  await expect(retireNativeCustomProviders(f.input)).rejects.toThrow("Could not remove");
  expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  expect(f.clear).not.toHaveBeenCalled();
});

it("keeps the current provider and rejects another sandbox's cleanup authority (#12636)", async () => {
  const f = await fixture();
  await retireNativeCustomProviders({ ...f.input, keepProviderName: f.receipt.providerName });
  expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  await expect(retireNativeCustomProviders({ ...f.input, sandboxName: "peer" })).rejects.toThrow(
    "does not match",
  );
  expect(f.adapter.getProvider).not.toHaveBeenCalled();
});

it("retains cleanup authority after HTTPS adapter revocation fails and converges on retry (#12636)", async () => {
  const source = "https://api.example.com/v1";
  const endpoint = `${buildHttpsPinRouteBaseUrl(computeHttpsPinRouteId("nemoclaw", "compatible-endpoint", source, "alpha"))}/v1`;
  const prepared = {
    ...buildNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl: endpoint,
      api: "openai-completions",
      addresses: [],
      transport: {
        kind: "https-pin",
        gatewayName: "nemoclaw",
        sourceEndpointUrl: source,
        sourceAddresses: ["8.8.8.8"],
        trustedPrivateEndpoint: false,
      },
    }),
    trustedPrivateEndpoint: false,
  };
  const f = await fixture(prepared);
  const revoke = vi.fn(async () => true).mockResolvedValueOnce(false);
  await expect(retireNativeCustomProviders({ ...f.input, revokeRoute: revoke })).rejects.toThrow(
    "authority is retained",
  );
  expect(f.clear).not.toHaveBeenCalled();
  await retireNativeCustomProviders({ ...f.input, revokeRoute: revoke });
  expect(f.adapter.deleteProvider).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(f.clear).toHaveBeenCalledTimes(1);
});
