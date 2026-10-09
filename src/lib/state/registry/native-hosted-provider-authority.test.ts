// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  HOSTED_NATIVE_PROVIDERS,
  hostedNativeProvider,
} from "../../inference/native-provider/hosted";
import { normalizeNativeHostedProviderAuthorities } from "./native-provider-authority-state";

const openai = {
  schemaVersion: 1,
  profileId: "nemoclaw-openai-inference-v1",
  providerName: "nemoclaw-openai-api-v1",
  providerId: "openai-identity",
} as const;
const anthropic = {
  schemaVersion: 1,
  profileId: "nemoclaw-anthropic-inference-v1",
  providerName: "nemoclaw-anthropic-prod-v1",
  providerId: "anthropic-identity",
} as const;

it("refuses a receipt bound to a different hosted provider (#12589)", () => {
  expect(() =>
    normalizeNativeHostedProviderAuthorities({
      gateway: { "openai-api": anthropic },
    }),
  ).toThrow(/Invalid native hosted provider attachment/u);
});

it("strips unrecognized fields and keeps each provider's exact identity (#12589)", () => {
  const receipts = Object.fromEntries(
    HOSTED_NATIVE_PROVIDERS.map((provider) => [
      provider.logicalProvider,
      {
        schemaVersion: 1,
        profileId: provider.profileId,
        providerName: provider.providerName,
        providerId: `identity-${provider.logicalProvider}`,
        credential: "must-not-persist",
      },
    ]),
  );
  const normalized = normalizeNativeHostedProviderAuthorities({ gateway: receipts });
  expect(Object.keys(normalized?.gateway ?? {})).toHaveLength(5);
  expect(JSON.stringify(normalized)).not.toContain("must-not-persist");
  expect(normalized?.gateway["openai-api"].providerId).toBe("identity-openai-api");
});

it("preserves gateway ownership and the other sandbox when changing a selection (#12589)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-hosted-authority-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    const registry = await import("../registry");
    const { load, save } = await import("./persistence");
    const { setupInferenceProviderDeps } = (await import("../../onboard/providers")) as unknown as {
      setupInferenceProviderDeps: (
        run: () => never,
      ) => Pick<
        typeof registry,
        "getNativeHostedProviderAuthority" | "setNativeHostedProviderAuthority"
      >;
    };
    const onboarding = setupInferenceProviderDeps(() => {
      throw new Error("Ownership persistence must not invoke OpenShell");
    });
    onboarding.setNativeHostedProviderAuthority("gateway", "openai-api", openai);
    registry.setNativeHostedProviderAuthority("gateway", "anthropic-prod", anthropic);
    registry.setNativeHostedProviderAuthority("other-gateway", "openai-api", {
      ...openai,
      providerId: "other-identity",
    });
    const nvidia = {
      schemaVersion: 1,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: "nvidia-identity",
    } as const;
    registry.setNativeNvidiaProviderAuthority("gateway", nvidia);
    registry.registerSandbox({
      name: "alpha",
      gatewayName: "gateway",
      provider: "openai-api",
      model: "gpt-5.4",
      nativeHostedProviderAttachment: openai,
    });
    registry.registerSandbox({
      name: "beta",
      gatewayName: "gateway",
      provider: "openai-api",
      model: "gpt-5.4",
      nativeHostedProviderAttachment: openai,
    });
    registry.reserveSandboxInferenceRoute("alpha", {
      gatewayName: "gateway",
      provider: "anthropic-prod",
      model: "claude-sonnet-4-6",
      nativeHostedProviderAttachment: anthropic,
      credentialEnv: "ANTHROPIC_API_KEY",
      endpointUrl: "https://api.anthropic.com",
      preferredInferenceApi: "anthropic-messages",
    });
    // Re-serialize and reload rather than relying on an in-memory object.
    save(load());
    expect(registry.getSandbox("alpha")?.nativeHostedProviderAttachment).toEqual(anthropic);
    expect(registry.getSandbox("beta")?.nativeHostedProviderAttachment).toEqual(openai);
    expect(registry.getNativeHostedProviderAuthority("gateway", "openai-api")).toEqual(openai);
    expect(onboarding.getNativeHostedProviderAuthority("gateway", "openai-api")).toEqual(openai);
    expect(registry.getNativeHostedProviderAuthority("gateway", "anthropic-prod")).toEqual(
      anthropic,
    );
    expect(
      registry.getNativeHostedProviderAuthority("other-gateway", "openai-api")?.providerId,
    ).toBe("other-identity");
    expect(registry.getNativeNvidiaProviderAuthority("gateway")).toEqual(nvidia);
    expect(() =>
      registry.registerSandbox({
        name: "wrong",
        provider: "openai-api",
        nativeHostedProviderAttachment: anthropic,
        credentialEnv: "ANTHROPIC_API_KEY",
        endpointUrl: "https://api.anthropic.com",
        preferredInferenceApi: "anthropic-messages",
      }),
    ).toThrow(/Invalid native hosted provider attachment/u);
    expect(registry.getSandbox("wrong")).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});

it("retains independent Hermes ownership across authenticated endpoint changes (#12589)", async () => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-hermes-authority-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.resetModules();
  try {
    const registry = await import("../registry");
    const first = hostedNativeProvider("hermes-provider", "https://first.nous.example/v1")!;
    const second = hostedNativeProvider("hermes-provider", "https://second.nous.example/v1")!;
    const firstReceipt = {
      schemaVersion: 1 as const,
      profileId: first.profileId,
      providerName: first.providerName,
      providerId: "first-id",
      endpointUrl: first.endpoint,
    };
    const secondReceipt = {
      schemaVersion: 1 as const,
      profileId: second.profileId,
      providerName: second.providerName,
      providerId: "second-id",
      endpointUrl: second.endpoint,
    };
    registry.setNativeHostedProviderAuthority("gateway", "hermes-provider", firstReceipt);
    registry.setNativeHostedProviderAuthority("gateway", "hermes-provider", secondReceipt);
    expect(registry.getNativeHostedProviderAuthority("gateway", "hermes-provider")).toEqual(
      secondReceipt,
    );
    expect(
      registry.getNativeHostedProviderAuthority("gateway", "hermes-provider", first.endpoint),
    ).toEqual(firstReceipt);
    expect(
      registry.getNativeHostedProviderAuthority("gateway", "hermes-provider", second.endpoint),
    ).toEqual(secondReceipt);
    expect(
      registry.getNativeHostedProviderAuthority("other-gateway", "hermes-provider", first.endpoint),
    ).toBeUndefined();
    const authority = await import("./native-provider-authority");
    registry.setNativeHostedProviderAuthority("other-gateway", "hermes-provider", firstReceipt);
    authority.clearNativeHostedProviderAuthority("gateway", {
      ...firstReceipt,
      providerId: "foreign-id",
    });
    expect(authority.getNativeHostedProviderAuthorityByName("gateway", first.providerName)).toEqual(
      firstReceipt,
    );
    authority.clearNativeHostedProviderAuthority("gateway", firstReceipt);
    expect(
      authority.getNativeHostedProviderAuthorityByName("gateway", first.providerName),
    ).toBeUndefined();
    expect(registry.getNativeHostedProviderAuthority("gateway", "hermes-provider")).toEqual(
      secondReceipt,
    );
    expect(registry.getNativeHostedProviderAuthority("other-gateway", "hermes-provider")).toEqual(
      firstReceipt,
    );
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(temporaryHome, { recursive: true, force: true });
  }
});
