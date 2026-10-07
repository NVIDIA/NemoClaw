// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { nativeLocalIdentity, type NativeLocalBinding } from "../inference/native-local/contract";
import { prepareNativeLocalSelection } from "../inference/native-local/selection";
import {
  ensureNativeLocalProviderAttached,
  detachNativeLocalProvider,
} from "../inference/native-local/profile";
import { prepareNativeLocalSwitch, rollbackNativeLocalSelection } from "./inference/native-local";

vi.mock("../inference/native-local/selection", () => ({ prepareNativeLocalSelection: vi.fn() }));
vi.mock("../inference/native-local/profile", () => ({
  ensureNativeLocalProviderAttached: vi.fn(),
  detachNativeLocalProvider: vi.fn(),
}));
const binding: NativeLocalBinding = {
  provider: "compatible-endpoint",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  gatewayName: "selected",
  sandboxName: "alice",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
};
const previous = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "previous-id",
};
const nextBinding = { ...binding, endpointUrl: "http://host.openshell.internal:11434/v1" };
const next = {
  ...nextBinding,
  ...nativeLocalIdentity(nextBinding),
  schemaVersion: 1 as const,
  providerId: "next-id",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prepareNativeLocalSelection).mockResolvedValue(next);
  vi.mocked(ensureNativeLocalProviderAttached).mockResolvedValue({ receipt: next, changed: true });
});
function fixture() {
  const listProviderAttachments = vi.fn(async () => ({ ok: true as const, value: { names: [] } }));
  return {
    local: {
      getLocalProviderBaseUrl: vi.fn(() => "http://host.openshell.internal:11434/v1"),
      getManagedVllmProviderBinding: vi.fn(() => null),
      shouldFrontOllamaWithProxy: vi.fn(() => false),
    },
    provider: "compatible-endpoint",
    gatewayName: "selected",
    sandboxName: "alice",
    previous,
    binding: {
      baseUrl: next.endpointUrl,
      token: "test-only-secret",
      credentialEnv: "COMPATIBLE_API_KEY",
      providerType: "openai" as const,
    },
    adapter: { listProviderAttachments } as unknown as OpenShellProviderAdapter,
    resolveCredentialValue: vi.fn(() => {
      throw new Error("unexpected host credential read");
    }),
  };
}
describe("native local inference replacement", () => {
  it("keeps model-only changes inside existing OpenShell credential custody (#12558)", async () => {
    const input = fixture();
    vi.mocked(ensureNativeLocalProviderAttached).mockResolvedValue({
      receipt: previous,
      changed: false,
    });
    await expect(prepareNativeLocalSwitch({ ...input, binding: null })).resolves.toMatchObject({
      receipt: previous,
      previousDetached: false,
    });
    expect(prepareNativeLocalSelection).not.toHaveBeenCalled();
    expect(detachNativeLocalProvider).not.toHaveBeenCalled();
    expect(input.resolveCredentialValue).not.toHaveBeenCalled();
  });
  it("removes the previous endpoint only from the selected sandbox before attaching its replacement (#12558)", async () => {
    const input = fixture();
    await expect(prepareNativeLocalSwitch(input)).resolves.toMatchObject({
      receipt: next,
      previousDetached: true,
    });
    expect(detachNativeLocalProvider).toHaveBeenCalledExactlyOnceWith({
      adapter: input.adapter,
      sandboxName: "alice",
      expected: previous,
    });
    expect(ensureNativeLocalProviderAttached).toHaveBeenCalledExactlyOnceWith({
      adapter: input.adapter,
      sandboxName: "alice",
      expected: next,
    });
    expect(vi.mocked(detachNativeLocalProvider).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ensureNativeLocalProviderAttached).mock.invocationCallOrder[0],
    );
  });
  it("restores previous access after a rejected attachment is confirmed absent (#12558)", async () => {
    const input = fixture();
    vi.mocked(ensureNativeLocalProviderAttached).mockRejectedValueOnce(
      new Error("attachment denied"),
    );
    await expect(prepareNativeLocalSwitch(input)).rejects.toThrow("attachment denied");
    expect(input.adapter.listProviderAttachments).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "selected" },
      sandboxName: "alice",
    });
    expect(ensureNativeLocalProviderAttached).toHaveBeenLastCalledWith({
      adapter: input.adapter,
      sandboxName: "alice",
      expected: previous,
    });
  });
  it("does not mutate again when failed attachment observation is inconclusive (#12558)", async () => {
    const input = fixture();
    vi.mocked(input.adapter.listProviderAttachments).mockResolvedValue({
      ok: false,
      error: { kind: "transport", reason: "connection_loss", message: "lost" },
    } as never);
    vi.mocked(ensureNativeLocalProviderAttached).mockRejectedValueOnce(
      new Error("attachment unknown"),
    );
    await expect(prepareNativeLocalSwitch(input)).rejects.toThrow("could not be reconciled");
    expect(ensureNativeLocalProviderAttached).toHaveBeenCalledTimes(1);
    expect(detachNativeLocalProvider).toHaveBeenCalledTimes(1);
  });
});

describe("native local selection compensation", () => {
  function rollbackInput() {
    return {
      adapter: fixture().adapter,
      sandboxName: "alice",
      provider: "compatible-endpoint",
      attachment: next,
      previous,
      attachmentChanged: true,
      registryCommitted: false,
      previousDetached: true,
      previousDetachCommitted: false,
      getSandbox: vi.fn(() => ({
        name: "alice",
        provider: "compatible-endpoint",
        nativeLocalProviderAttachment: previous,
      })),
    };
  }
  it("restores the old endpoint after an uncommitted same-provider switch (#12558)", async () => {
    await rollbackNativeLocalSelection(rollbackInput());
    expect(detachNativeLocalProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expected: next }),
    );
    expect(ensureNativeLocalProviderAttached).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expected: previous }),
    );
    expect(vi.mocked(detachNativeLocalProvider).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ensureNativeLocalProviderAttached).mock.invocationCallOrder[0]!,
    );
  });
  it("retains the new attachment after a registry write committed but its response was lost (#12558)", async () => {
    const input = rollbackInput();
    input.getSandbox.mockReturnValue({
      name: "alice",
      provider: "compatible-endpoint",
      nativeLocalProviderAttachment: next,
    });
    await rollbackNativeLocalSelection(input);
    expect(detachNativeLocalProvider).not.toHaveBeenCalled();
    expect(ensureNativeLocalProviderAttached).not.toHaveBeenCalled();
  });
  it("retains provider authority when registry observation fails (#12558)", async () => {
    const input = rollbackInput();
    input.getSandbox.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    await expect(rollbackNativeLocalSelection(input)).rejects.toThrow("registry unavailable");
    expect(detachNativeLocalProvider).not.toHaveBeenCalled();
    expect(ensureNativeLocalProviderAttached).not.toHaveBeenCalled();
  });
});
