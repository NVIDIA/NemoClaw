// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { nativeCompatibleFixture } from "../inference/native-compatible/switch.test-support";
import {
  nativeBedrockIdentity,
  type NativeBedrockProviderAttachment,
} from "../inference/native-bedrock/contract";
import { BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL } from "../inference/bedrock-runtime";
import { retireAbsentSandboxNativeProviders } from "./sandbox-provider-cleanup";

type Deps = Parameters<typeof retireAbsentSandboxNativeProviders>[1];
type Entries = ReturnType<Deps["listSandboxes"]>;

async function fixture() {
  const { receipt: compatible } = await nativeCompatibleFixture();
  const binding = {
    endpointUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    adapterGeneration: "a".repeat(32),
    adapterBaseUrl: BEDROCK_RUNTIME_ADAPTER_OPENAI_BASE_URL,
    gatewayName: "gateway",
  };
  const bedrock: NativeBedrockProviderAttachment = {
    ...binding,
    ...nativeBedrockIdentity(binding),
    schemaVersion: 1,
    providerId: "owned-bedrock",
  };
  const input = { sandboxName: "selected", gatewayName: "gateway", compatible, bedrock };
  let locked = false;
  const listSandboxes = vi.fn((): Entries => {
    expect(locked).toBe(true);
    return [
      {
        name: "selected",
        gatewayName: "gateway",
        nativeCompatibleProviderAttachment: compatible,
        nativeBedrockProviderAttachment: bedrock,
      },
    ];
  });
  const withGatewayRouteMutationLock = vi.fn(
    async (gateway: string, operation: () => Promise<void>) => {
      expect(gateway).toBe("gateway");
      locked = true;
      try {
        return await operation();
      } finally {
        locked = false;
      }
    },
  );
  const retireCompatible = vi.fn<Deps["retireCompatible"]>(async () => {
    expect(locked).toBe(true);
  });
  const retireBedrock = vi.fn<Deps["retireBedrock"]>(async () => {
    expect(locked).toBe(true);
  });
  return {
    input,
    deps: { listSandboxes, withGatewayRouteMutationLock, retireCompatible, retireBedrock },
  };
}

it("reads current registry and retires only selected receipts while holding the gateway lock", async () => {
  const { input, deps } = await fixture();
  await retireAbsentSandboxNativeProviders(input, deps);
  expect(deps.withGatewayRouteMutationLock).toHaveBeenCalledOnce();
  expect(deps.listSandboxes).toHaveBeenCalledOnce();
  expect(deps.retireCompatible).toHaveBeenCalledWith(
    { deletionConfirmed: true, gatewayName: "gateway", expected: input.compatible },
    expect.anything(),
  );
  expect(deps.retireBedrock).toHaveBeenCalledWith(
    { gatewayName: "gateway", expected: input.bedrock },
    expect.anything(),
  );
});

it.each([true, false])(
  "preserves shared providers for a peer with pending reservation=%s",
  async (pendingRouteReservation) => {
    const { input, deps } = await fixture();
    const peer = {
      name: "peer",
      gatewayName: "gateway",
      pendingRouteReservation,
      nativeCompatibleProviderAttachment: input.compatible,
      nativeBedrockProviderAttachment: input.bedrock,
    };
    deps.listSandboxes.mockReturnValue([peer]);
    await retireAbsentSandboxNativeProviders(input, deps);
    expect(deps.retireCompatible).not.toHaveBeenCalled();
    expect(deps.retireBedrock).not.toHaveBeenCalled();
  },
);

it("does not mutate either provider when registry observation fails", async () => {
  const { input, deps } = await fixture();
  deps.listSandboxes.mockImplementation(() => {
    throw new Error("registry unavailable");
  });
  await expect(retireAbsentSandboxNativeProviders(input, deps)).rejects.toThrow(
    "registry unavailable",
  );
  expect(deps.retireCompatible).not.toHaveBeenCalled();
  expect(deps.retireBedrock).not.toHaveBeenCalled();
});

it("propagates retirement rejection without attempting further retirement", async () => {
  const { input, deps } = await fixture();
  deps.retireCompatible.mockRejectedValue(new Error("ownership changed"));
  await expect(retireAbsentSandboxNativeProviders(input, deps)).rejects.toThrow(
    "ownership changed",
  );
  expect(deps.retireCompatible).toHaveBeenCalledOnce();
  expect(deps.retireBedrock).not.toHaveBeenCalled();
});

it("does not acquire a lock or inspect state without native receipts", async () => {
  const { deps } = await fixture();
  await retireAbsentSandboxNativeProviders(
    { sandboxName: "selected", gatewayName: "gateway" },
    deps,
  );
  expect(deps.withGatewayRouteMutationLock).not.toHaveBeenCalled();
  expect(deps.listSandboxes).not.toHaveBeenCalled();
  expect(deps.retireCompatible).not.toHaveBeenCalled();
  expect(deps.retireBedrock).not.toHaveBeenCalled();
});
