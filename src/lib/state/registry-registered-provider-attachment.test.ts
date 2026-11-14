// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SandboxEntry } from "./registry/types";
import type { RegisteredInferenceProviderAttachment } from "../inference/native-provider/registered";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-registered-provider-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function selectedProvider(attachedBySelection = false): SandboxEntry {
  const binding: RegisteredInferenceProviderAttachment = {
    schemaVersion: 1,
    gatewayName: "nemoclaw",
    sandboxName: "alpha",
    providerName: "operator-provider",
    providerId: "operator-provider-id",
    profileId: "operator-profile",
    profileDigest: "a".repeat(64),
    endpointUrl: "https://api.example/v1",
    inferenceApi: "openai-completions",
    credentialEnv: "OPERATOR_API_KEY",
    attachedBySelection,
  };
  return {
    name: binding.sandboxName,
    gatewayName: binding.gatewayName,
    provider: binding.providerName,
    model: "model-a",
    endpointUrl: binding.endpointUrl,
    preferredInferenceApi: binding.inferenceApi,
    credentialEnv: binding.credentialEnv,
    registeredInferenceProviderAttachment: binding,
  };
}

it.each([false, true])(
  "persists an operator binding without adopting its provider (attachment created: %s)",
  async (created) => {
    const registry = await import("./registry");
    const { REGISTRY_FILE } = await import("./registry/persistence");
    const entry = selectedProvider(created);
    registry.registerSandbox(entry);
    expect(registry.getSandbox("alpha")?.registeredInferenceProviderAttachment).toEqual(
      entry.registeredInferenceProviderAttachment,
    );
    const disk = JSON.parse(await fs.readFile(REGISTRY_FILE, "utf8"));
    expect(disk.nativeHostedProviderAuthorities).toBeUndefined();
    expect(disk.nativeNvidiaProviderAuthorities).toBeUndefined();
    expect(disk.sandboxes.alpha.nativeHostedProviderAttachment).toBeUndefined();
  },
);

it.each([
  ["gateway", { gatewayName: "other" }],
  ["sandbox", { sandboxName: "other" }],
  ["provider", { providerName: "other" }],
  ["endpoint", { endpointUrl: "https://other.example/v1" }],
  ["API", { inferenceApi: "openai-responses" }],
  ["credential", { credentialEnv: "OTHER_KEY" }],
] as const)("rejects a persisted operator binding with a different %s", async (_label, change) => {
  const registry = await import("./registry");
  const { REGISTRY_FILE } = await import("./registry/persistence");
  registry.registerSandbox(selectedProvider());
  const disk = JSON.parse(await fs.readFile(REGISTRY_FILE, "utf8"));
  Object.assign(disk.sandboxes.alpha.registeredInferenceProviderAttachment, change);
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(disk));
  expect(() => registry.getSandbox("alpha")).toThrow(
    "Recorded registered inference selection does not match its sandbox route",
  );
});

it("rejects invalid binding updates before replacing durable state", async () => {
  const registry = await import("./registry");
  const { REGISTRY_FILE } = await import("./registry/persistence");
  const entry = selectedProvider();
  registry.registerSandbox(entry);
  const before = await fs.readFile(REGISTRY_FILE, "utf8");
  expect(() =>
    registry.updateSandbox("alpha", {
      registeredInferenceProviderAttachment: {
        ...entry.registeredInferenceProviderAttachment!,
        providerId: "",
      },
    }),
  ).toThrow(/registered inference provider/i);
  expect(await fs.readFile(REGISTRY_FILE, "utf8")).toBe(before);
});

it.each([
  ["model", { model: "model-b" }, true],
  ["endpoint", { endpointUrl: "https://other.example/v1" }, false],
  ["provider", { provider: "other-provider" }, false],
] as const)(
  "retains an operator binding only for the same reservation identity: %s",
  async (_label, change, retained) => {
    const registry = await import("./registry");
    const entry = selectedProvider();
    registry.registerSandbox(entry);
    registry.reserveSandboxInferenceRoute("alpha", {
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      endpointUrl: entry.endpointUrl ?? null,
      credentialEnv: entry.credentialEnv ?? null,
      preferredInferenceApi: entry.preferredInferenceApi ?? null,
      gatewayName: entry.gatewayName!,
      ...change,
    });
    expect(registry.getSandbox("alpha")?.registeredInferenceProviderAttachment).toEqual(
      retained ? entry.registeredInferenceProviderAttachment : undefined,
    );
  },
);

it("excludes only a coherent operator binding from shared-route checks", async () => {
  const { isSharedGatewayRouteParticipant } = await import("./registry/route-reservation");
  const entry = selectedProvider();
  expect(isSharedGatewayRouteParticipant(entry)).toBe(false);
  expect(isSharedGatewayRouteParticipant({ ...entry, gatewayName: "other" })).toBe(true);
});

it("lists selected operator providers only for the requested gateway and provider", async () => {
  const registry = await import("./registry");
  const { listRegisteredInferenceProviderAttachmentSandboxNames: names } =
    await import("./registry/native-provider-authority");
  registry.registerSandbox(selectedProvider());
  expect(names("nemoclaw", "operator-provider")).toEqual(["alpha"]);
  expect(names("other", "operator-provider")).toEqual([]);
  expect(names("nemoclaw", "other-provider")).toEqual([]);
});
