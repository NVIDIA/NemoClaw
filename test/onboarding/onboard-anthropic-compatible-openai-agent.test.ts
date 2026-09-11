// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// #6294: an OpenAI-/chat/completions-only agent (langchain-deepagents-code)
// onboarded on the Custom Anthropic-compatible provider is coerced onto
// openai-completions; the gateway provider must then be registered type=openai
// (OPENAI_BASE_URL) after verifying the endpoint really serves the OpenAI
// surface, so OpenShell routes the sandbox's openai_chat_completions traffic.
// The anthropic-flavor endpoint normalization strips a trailing /v1, so the
// branch re-adds it for both the probe and the registered base URL — keeping
// the probed URL identical to the one OpenShell calls at runtime.

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
const SURFACE_URL = `${ENDPOINT}/v1`;
const CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const MODEL = "nvidia/nvidia/nemotron-3-super-v3";

function createInjectedExit() {
  return vi.fn((code: number): never => {
    throw new Error(`EXIT_CALLED:${code}`);
  });
}

/** Declarative openshell stub keyed on the first two argv tokens. */
function commandStubs(routes: Record<string, { status: number; stderr?: string }>) {
  return (args: string[]) => routes[`${args[0]} ${args[1]}`];
}

/** Route `provider get` to "absent" so the real upsert takes the create path. */
const providerAbsentRunner = commandStubs({ "provider get": { status: 1 } });

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

  it("registers the provider as type=openai on the /v1 surface after the probe passes", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: providerAbsentRunner,
      overrides: { probeOpenAiLikeEndpoint },
    });

    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });

    // The probe must exercise the same /v1 base OpenShell will call at
    // runtime (<OPENAI_BASE_URL> + /v1/chat/completions with /v1 dedup).
    expect(probeOpenAiLikeEndpoint).toHaveBeenCalledWith(SURFACE_URL, MODEL, "hub-secret", {
      pinnedAddresses: ["93.184.216.34"],
      skipResponsesProbe: true,
    });
    const createCommand = harness.commands.find(({ command }) =>
      command.startsWith("provider create"),
    );
    expect(createCommand?.command).toContain("--type openai");
    expect(createCommand?.command).toContain(`OPENAI_BASE_URL=${SURFACE_URL}`);
    expect(createCommand?.command).toContain(`--credential ${CREDENTIAL_ENV}`);
    expect(
      harness.commands.some(({ command }) =>
        command.includes(`inference set -g nemoclaw --provider ${PROVIDER} --model ${MODEL}`),
      ),
    ).toBe(true);
  });

  it("replaces an unattached stale Anthropic-surface registration with a plain delete", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV),
      overrides: { probeOpenAiLikeEndpoint },
    });

    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });

    // Plain delete succeeded (default status 0) — no force-detach recovery.
    expect(
      harness.commands.some(({ command }) => command === `provider delete -g nemoclaw ${PROVIDER}`),
    ).toBe(true);
    expect(harness.commands.some(({ command }) => command.includes("provider detach"))).toBe(false);
    const createCommand = harness.commands.find(({ command }) =>
      command.startsWith("provider create"),
    );
    expect(createCommand?.command).toContain("--type openai");
  });

  it("recovers the flip when the stale provider is attached only to the onboarding sandbox", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV, ["test-box"]),
      overrides: { probeOpenAiLikeEndpoint },
    });

    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
    });

    expect(harness.commands.filter(({ command }) => command.includes("provider detach"))).toEqual([
      expect.objectContaining({
        command: `sandbox provider detach -g nemoclaw test-box ${PROVIDER}`,
      }),
    ]);
    const createCommand = harness.commands.find(({ command }) =>
      command.startsWith("provider create"),
    );
    expect(createCommand?.command).toContain("--type openai");
  });

  it("fails closed when the stale provider is attached to other sandboxes", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const exitProcess = createInjectedExit();
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: createStaleAnthropicProviderRunner(PROVIDER, CREDENTIAL_ENV, [
        "other-box",
        "test-box",
      ]),
      overrides: {
        probeOpenAiLikeEndpoint,
        exitProcess,
        isNonInteractive: () => true,
      },
    });

    await expect(
      harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
        preferredInferenceApi: "openai-completions",
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(harness.commands.some(({ command }) => command.includes("provider detach"))).toBe(false);
    expect(
      harness.errors.some((message) =>
        message.includes("attached to other sandbox(es) (other-box)"),
      ),
    ).toBe(true);
    expect(harness.commands.some(({ command }) => command.startsWith("provider create"))).toBe(
      false,
    );
  });

  it("fails non-interactive onboarding actionably when the endpoint lacks the OpenAI surface", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const exitProcess = createInjectedExit();
    const probeOpenAiLikeEndpoint = vi.fn(() => ({
      ok: false,
      message: "POST /v1/chat/completions returned 404",
    }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: providerAbsentRunner,
      overrides: { probeOpenAiLikeEndpoint, exitProcess, isNonInteractive: () => true },
    });

    await expect(
      harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
        preferredInferenceApi: "openai-completions",
      }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(
      harness.errors.some((message) =>
        message.includes("requires an OpenAI-compatible /v1/chat/completions surface"),
      ),
    ).toBe(true);
    expect(harness.commands.some(({ command }) => command.startsWith("provider create"))).toBe(
      false,
    );
  });

  it("keeps the Anthropic registration for native anthropic-messages selections", async () => {
    vi.stubEnv(CREDENTIAL_ENV, "hub-secret");
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: providerAbsentRunner,
      overrides: { probeOpenAiLikeEndpoint },
    });

    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "anthropic-messages",
    });

    expect(probeOpenAiLikeEndpoint).not.toHaveBeenCalled();
    const createCommand = harness.commands.find(({ command }) =>
      command.startsWith("provider create"),
    );
    expect(createCommand?.command).toContain("--type anthropic");
    expect(createCommand?.command).toContain(`ANTHROPIC_BASE_URL=${ENDPOINT}`);
  });

  it("skips the surface probe on keyless gateway-credential reuse", async () => {
    const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: commandStubs({ "provider get": { status: 0 } }),
      overrides: { probeOpenAiLikeEndpoint },
    });

    await harness.setupInference("test-box", MODEL, PROVIDER, ENDPOINT, CREDENTIAL_ENV, null, [], {
      preferredInferenceApi: "openai-completions",
      reuseGatewayCredentialWithoutLocalKey: true,
    });

    expect(probeOpenAiLikeEndpoint).not.toHaveBeenCalled();
    expect(
      harness.commands.some(
        ({ command }) =>
          command.startsWith("provider create") || command.startsWith("provider update"),
      ),
    ).toBe(false);
  });
});
