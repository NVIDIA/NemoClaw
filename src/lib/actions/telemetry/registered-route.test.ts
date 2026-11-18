// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import type { SandboxEntry } from "../../state/registry/types";

const mocks = vi.hoisted(() => ({ registry: vi.fn(), reader: vi.fn() }));
vi.mock("../../state/gateway-registry", async (original) => ({
  ...(await original<typeof import("../../state/gateway-registry")>()),
  listGatewayStateRoots: () => [{ root: "/unused", gatewayPort: 8080 }],
  readGatewayRegistryFile: mocks.registry,
}));
vi.mock("./native-reader", () => ({ createSupervisedSandboxCommandReader: mocks.reader }));
vi.mock("../sandbox/mcp-bridge-provider-inspection", () => ({
  getMcpProviderInspectionRuntimeSelection: () => ({
    gatewayName: "nemoclaw",
    workspace: "native",
  }),
}));

import { collectOperationSnapshot } from "./snapshot";

it.each([
  "valid",
  "malformed",
  "wrong-gateway",
  "wrong-sandbox",
  "wrong-endpoint",
  "wrong-credential",
  "wrong-provider",
  "conflicting-attachment",
] as const)("keeps registered telemetry on its sandbox authority: %s", async (state) => {
  const binding = {
    ...registeredInferenceFixture(true).binding,
    sandboxName: "native",
    gatewayName: state === "wrong-gateway" ? "other-gateway" : "nemoclaw",
  };
  const entry: Partial<SandboxEntry> = {
    name: "native",
    agent: "pi",
    gatewayPort: 8080,
    gatewayName: "nemoclaw",
    provider: binding.providerName,
    model: "selected-model",
    endpointUrl: binding.endpointUrl,
    preferredInferenceApi: binding.inferenceApi,
    credentialEnv: binding.credentialEnv,
    registeredInferenceProviderAttachment: {
      ...binding,
      ...(state === "malformed" ? { profileDigest: "invalid" } : {}),
      ...(state === "wrong-sandbox" ? { sandboxName: "other-sandbox" } : {}),
    },
    ...(state === "wrong-endpoint" ? { endpointUrl: "https://other.example/v1" } : {}),
    ...(state === "wrong-credential" ? { credentialEnv: "OTHER_KEY" } : {}),
    ...(state === "wrong-provider" ? { provider: "other-provider" } : {}),
    ...(state === "conflicting-attachment"
      ? {
          nativeHostedProviderAttachment: {
            schemaVersion: 1 as const,
            profileId: "other-profile",
            providerName: "other-provider",
            providerId: "other-id",
          },
        }
      : {}),
  };
  mocks.registry.mockReturnValue({ defaultSandbox: null, sandboxes: { native: entry } });
  const observeInferenceRoute = vi.fn(async () => ({
    ok: true,
    value: {
      state: "configured",
      route: { provider: "other-provider", model: "other-sandbox-model" },
    },
  }));
  mocks.reader.mockReturnValue({
    read: vi.fn(async () => "Linux"),
    observeInferenceRoute,
    dispose: vi.fn(),
  });
  const snapshot = await collectOperationSnapshot({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
  });
  expect(snapshot.configurations[0]).toMatchObject({
    currentInferenceRouteStatus: state === "valid" ? "reported" : "collection_error",
    currentInferenceRoute: { modelId: state === "valid" ? "selected-model" : "unknown" },
  });
  expect(observeInferenceRoute).not.toHaveBeenCalled();
});
