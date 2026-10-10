// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// #6294 and #12636: preserve the agent-selected OpenAI or Anthropic surface
// while replacing fresh hosted custom shared routes with sandbox-owned native
// authority. A pre-existing shared provider never grants native ownership.

import fs from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import {
  createDirectSetupInferenceHarnessFactory,
  createStaleAnthropicProviderRunner,
} from "../support/setup-inference-test-harness.js";

const testHome = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-remote-provider-"));
  // The production registry captures its path when the harness imports onboarding.
  vi.stubEnv("HOME", home);
  return home;
});

const { default: onboard } = (await import("../../src/lib/onboard")) as unknown as {
  default: { createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference };
};
const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

const PROVIDER = "compatible-anthropic-endpoint";
// Production hands the anthropic-flavor-normalized origin (trailing /v1
// stripped by normalizeProviderBaseUrl) to setupInference.
const ENDPOINT = "https://inference-hub.example";
const CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const MODEL = "nvidia/nvidia/nemotron-3-super-v3";

describe("compatible-anthropic-endpoint registration for OpenAI-only agents (#6294)", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", testHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => fs.rmSync(testHome, { recursive: true, force: true }));

  it.each<[string, string[]]>([
    ["get", ["provider", "get", "other-provider"]],
    ["delete", ["provider", "delete", "other-provider"]],
    ["detach", ["sandbox", "provider", "detach", "test-box", "other-provider"]],
  ])(
    "rejects a mismatched provider name during fixture %s without changing its state",
    (_operation, args) => {
      const runner = createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV, ["test-box"]);
      expect(runner(args)).toEqual({
        status: 1,
        stderr: "provider 'other-provider' not found",
      });
      expect(runner(["provider", "get", PROVIDER])?.status).toBe(0);
      expect(runner(["provider", "delete", PROVIDER])).toEqual({
        status: 1,
        stderr: `provider '${PROVIDER}' is attached to sandbox(es): test-box`,
      });
    },
  );

  it.each<[string, string[]]>([
    ["get", ["provider", "get", PROVIDER]],
    ["delete", ["provider", "delete", PROVIDER]],
    ["detach", ["sandbox", "provider", "detach", "test-box", PROVIDER]],
  ])("reports provider absence during fixture %s after deletion", (_operation, args) => {
    const runner = createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV);
    expect(runner(["provider", "delete", PROVIDER])).toEqual({ status: 0 });
    expect(runner(args)).toEqual({
      status: 1,
      stderr: `provider '${PROVIDER}' not found`,
    });
  });

  it.each(["openai-completions", "anthropic-messages"] as const)(
    "binds a fresh custom Anthropic selection to its requested %s native surface",
    async (api) => {
      vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
      const harness = createDirectSetupInferenceHarness();
      await harness.setupInference(
        "test-box",
        MODEL,
        PROVIDER,
        ENDPOINT,
        CREDENTIAL_ENV,
        null,
        [],
        {
          preferredInferenceApi: api,
        },
      );
      const receipt = harness.updateSandbox.mock.lastCall?.[1]?.nativeCustomProviderAttachment;
      expect(receipt).toMatchObject({
        api,
        sandboxName: "test-box",
        credentialEnv: CREDENTIAL_ENV,
        transport: { sourceEndpointUrl: ENDPOINT },
      });
      expect(harness.native.providerAdapter.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "named", gatewayName: "nemoclaw" },
          name: receipt?.providerName,
          type: receipt?.profileId,
          credentials: [{ name: CREDENTIAL_ENV, value: expect.stringMatching(/^token-/u) }],
        }),
      );
      expect(harness.commands).toEqual([]);
      expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.updateSandbox.mock.calls)).not.toContain("hub-secret");
    },
  );

  it("keeps a stale shared Anthropic registration untouched while admitting a fresh native selection", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const stale = createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV, ["other-box"]);
    const harness = createDirectSetupInferenceHarness({ runOpenshell: stale });
    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });
    expect(stale(["provider", "get", PROVIDER])).toMatchObject({ status: 0 });
    expect(stale(["provider", "delete", PROVIDER])?.stderr).toContain("other-box");
    expect(harness.commands).toEqual([]);
  });

  it("refuses an observed native provider without durable ownership before preparing its adapter", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const harness = createDirectSetupInferenceHarness();
    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });
    const retry = createDirectSetupInferenceHarness({
      overrides: {
        ...harness.native,
        getNativeCustomProviderAuthority: () => undefined,
      },
    });
    await expect(
      retry.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
        preferredInferenceApi: "openai-completions",
      }),
    ).rejects.toThrow("ownership cannot be verified");
    expect(harness.native.providerAdapter.createProvider).toHaveBeenCalledOnce();
    expect(harness.native.nativeCustomTransportDeps.ensureHttpsAdapter).toHaveBeenCalledOnce();
    expect(retry.updateSandbox).not.toHaveBeenCalled();
    expect(retry.commands).toEqual([]);
  });

  it("rejects an incompatible native profile before starting transport or creating a provider", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const harness = createDirectSetupInferenceHarness();
    vi.mocked(harness.native.providerAdapter.importProviderProfile).mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible", message: "collision" },
    });
    await expect(
      harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
        preferredInferenceApi: "openai-completions",
      }),
    ).rejects.toThrow("conflicts with NemoClaw");
    expect(harness.native.nativeCustomTransportDeps.ensureHttpsAdapter).not.toHaveBeenCalled();
    expect(harness.native.providerAdapter.createProvider).not.toHaveBeenCalled();
    expect(harness.updateSandbox).not.toHaveBeenCalled();
  });

  it("uses distinct native identities for two sandbox selections of the same upstream", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const harness = createDirectSetupInferenceHarness();
    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });
    await harness.setupInference("other-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });
    const receipts = harness.updateSandbox.mock.calls.map(
      ([, patch]) => patch?.nativeCustomProviderAttachment,
    );
    expect(new Set(receipts.map((receipt) => receipt?.providerName)).size).toBe(2);
    expect(new Set(receipts.map((receipt) => receipt?.endpointUrl)).size).toBe(2);
    expect(harness.commands).toEqual([]);
  });

  it("reuses only the recorded native credential authority without rotating the upstream adapter", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const harness = createDirectSetupInferenceHarness();
    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });
    const recorded = { name: "test-box", ...harness.updateSandbox.mock.lastCall?.[1] };
    vi.stubEnv(CREDENTIAL_ENV, "");
    const retry = createDirectSetupInferenceHarness({
      overrides: { ...harness.native, getSandbox: () => recorded },
    });
    await retry.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
      reuseGatewayCredentialWithoutLocalKey: true,
    });
    expect(harness.native.nativeCustomTransportDeps.ensureHttpsAdapter).toHaveBeenCalledOnce();
    expect(harness.native.providerAdapter.createProvider).toHaveBeenCalledOnce();
    expect(retry.updateSandbox.mock.lastCall?.[1]?.nativeCustomProviderAttachment).toEqual(
      recorded.nativeCustomProviderAttachment,
    );
    expect(retry.commands).toEqual([]);
  });
});
