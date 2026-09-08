// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

type RunResult = {
  error?: unknown;
  output?: string;
  signal?: unknown;
  status: number;
  stdout?: string;
  stderr?: string;
};
type RunOptions = {
  env?: Record<string, string | undefined>;
  ignoreError?: boolean;
  maxBuffer?: number;
  stdio?: readonly unknown[];
  suppressOutput?: boolean;
  timeout?: number;
};
type RunOpenshell = (command: string[], opts?: RunOptions) => RunResult;

function providerMetadata(name: string, type: string, credentialKey: string): RunResult {
  return {
    status: 0,
    stdout: [
      `Id: provider-${name}`,
      `Name: ${name}`,
      `Type: ${type}`,
      "Resource version: 1",
      `Credential keys: ${credentialKey}`,
      "Config keys: <none>",
    ].join("\n"),
    stderr: "",
  };
}

const {
  HOSTED_INFERENCE_ENDPOINT_URL,
  HOSTED_INFERENCE_MODEL,
  NON_INTERACTIVE_PROVIDER_ALIASES,
  NON_INTERACTIVE_PROVIDER_KEYS,
  REMOTE_PROVIDER_CONFIG,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getRequestedModelHint,
  getRequestedProviderHint,
  isProviderKeyCredentialCandidate,
  providerExistsInGateway,
  stageHostedInferenceSourceSecretEnv,
  upsertProvider,
} = require("./providers") as {
  HOSTED_INFERENCE_ENDPOINT_URL: string;
  HOSTED_INFERENCE_MODEL: string;
  NON_INTERACTIVE_PROVIDER_ALIASES: Record<string, string>;
  NON_INTERACTIVE_PROVIDER_KEYS: Set<string>;
  REMOTE_PROVIDER_CONFIG: Record<
    string,
    {
      providerName: string;
      providerType: string;
      credentialEnv: string;
      defaultModel: string;
    }
  >;
  getNonInteractiveProvider: (allowHostedInferenceStaging?: boolean) => string | null;
  getNonInteractiveModel: (
    providerKey: string,
    options?: { allowProviderModelFallback?: boolean },
  ) => string | null;
  getRequestedModelHint: (
    nonInteractive: boolean,
    allowHostedInferenceStaging?: boolean,
  ) => string | null;
  getRequestedProviderHint: (
    nonInteractive: boolean,
    allowHostedInferenceStaging?: boolean,
  ) => string | null;
  isProviderKeyCredentialCandidate: (value: string | null | undefined) => boolean;
  providerExistsInGateway: (name: string, runOpenshell: RunOpenshell) => Promise<boolean>;
  stageHostedInferenceSourceSecretEnv: () => boolean;
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: RunOpenshell,
    options?: {
      knownExists?: boolean;
      replaceExisting?: boolean;
      allowedSandboxes?: readonly string[];
      requireExactBinding?: boolean;
      revalidateSandboxIdentity?(operation: string): void;
    },
  ) => Promise<{ ok: boolean; status?: number; message?: string; reason?: string }>;
};

function withProviderEnv(next: Record<string, string | undefined>, testBody: () => void): void {
  const keys = new Set([
    "NVIDIA_INFERENCE_API_KEY",
    "NEMOCLAW_AGENT",
    "NEMOCLAW_PROVIDER_KEY",
    "NEMOCLAW_PROVIDER",
    "NEMOCLAW_ENDPOINT_URL",
    "NEMOCLAW_MODEL",
    "NEMOCLAW_PROVIDER_MODEL",
    "NEMOCLAW_COMPAT_MODEL",
    "NEMOCLAW_PREFERRED_API",
    "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
    "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
    "COMPATIBLE_API_KEY",
    ...Object.keys(next),
  ]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    testBody();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("onboard provider helpers", () => {
  it("uses Gemini 3.6 Flash as the onboarding default (#9298)", async () => {
    expect(REMOTE_PROVIDER_CONFIG.gemini.defaultModel).toBe("gemini-3.6-flash");
  });

  it("keeps managed llama.cpp as a public non-interactive provider selector (#8433)", async () => {
    expect(NON_INTERACTIVE_PROVIDER_KEYS.has("install-llama-cpp")).toBe(true);
    withProviderEnv({ NEMOCLAW_PROVIDER: "install-llama-cpp" }, () => {
      expect(getNonInteractiveProvider(false)).toBe("install-llama-cpp");
    });
  });

  it("registers OpenRouter with an OpenAI-compatible provider profile and aliases (#5826)", async () => {
    const provider = REMOTE_PROVIDER_CONFIG.openrouter;

    expect(provider).toMatchObject({
      providerName: "openrouter-api",
      providerType: "openai",
      credentialEnv: "OPENROUTER_API_KEY",
    });
    expect(NON_INTERACTIVE_PROVIDER_KEYS.has("openrouter")).toBe(true);
    expect(NON_INTERACTIVE_PROVIDER_ALIASES["open-router"]).toBe("openrouter");
    expect(NON_INTERACTIVE_PROVIDER_ALIASES.openrouterai).toBe("openrouter");
  });

  it("keeps the discovery profile Anthropic before agent-specific surface selection (#6289)", async () => {
    const provider = REMOTE_PROVIDER_CONFIG.anthropicCompatible;

    // Remote provider setup can replace this registration with type=openai
    // after an agent selects and verifies the endpoint's OpenAI surface.
    expect(provider).toMatchObject({
      providerName: "compatible-anthropic-endpoint",
      providerType: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    });
  });

  it("checks whether providers exist in the gateway", async () => {
    expect(
      await providerExistsInGateway("discord-bridge", () =>
        providerMetadata("discord-bridge", "generic", "DISCORD_BOT_TOKEN"),
      ),
    ).toBe(true);
    expect(
      await providerExistsInGateway("missing-bridge", () => ({
        status: 1,
        stderr: "provider 'missing-bridge' not found",
      })),
    ).toBe(false);
  });

  it("fails closed when provider metadata is malformed", async () => {
    await expect(
      providerExistsInGateway("discord-bridge", () => ({
        status: 0,
        stdout: "unexpected output",
      })),
    ).rejects.toThrow("OpenShell returned invalid provider metadata");
  });

  it("treats an operational provider inspection failure as unavailable", async () => {
    await expect(
      providerExistsInGateway("discord-bridge", () => ({
        status: 1,
        stderr: "gateway temporarily unavailable",
      })),
    ).resolves.toBe(false);
  });

  it("creates a new provider and returns ok on success", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
      { DISCORD_BOT_TOKEN: "fake" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        if (normalized.includes("provider get")) {
          return { status: 1, stdout: "", stderr: "provider 'discord-bridge' not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/provider create --name discord-bridge/);
    expect(commands[1]).toMatch(/--credential DISCORD_BOT_TOKEN/);
  });

  it("does not add its own log line on top of runner output (#1506)", async () => {
    let stdoutWrites = 0;
    const result = await upsertProvider(
      "test-bridge",
      "generic",
      "TEST_TOKEN",
      null,
      { TEST_TOKEN: "tok" },
      (command) => {
        if (command.includes("get")) {
          return { status: 1, stdout: "", stderr: "provider 'test-bridge' not found" };
        }
        stdoutWrites += 1;
        return { status: 0, stdout: "✓ Created provider test-bridge", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(stdoutWrites).toBe(1);
  });

  it("updates existing providers instead of creating (#1155)", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "inference",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      {},
      (command) => {
        commands.push(command.join(" "));
        return command.includes("get")
          ? providerMetadata("inference", "openai", "NVIDIA_INFERENCE_API_KEY")
          : { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/provider update/);
    expect(commands[1]).toMatch(
      /--config OPENAI_BASE_URL=https:\/\/integrate\.api\.nvidia\.com\/v1/,
    );
  });

  it("omits --credential from the update args when the env value is empty", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "nvidia-prod",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      {},
      (command) => {
        commands.push(command.join(" "));
        return command.includes("get")
          ? providerMetadata("nvidia-prod", "openai", "NVIDIA_INFERENCE_API_KEY")
          : { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/^provider update nvidia-prod /);
    // OpenShell CLI rejects `--credential KEY` when the host env is empty;
    // dropping the flag turns the call into a no-op merge that succeeds.
    expect(commands[1]).not.toMatch(/--credential/);
    expect(commands[1]).toMatch(/OPENAI_BASE_URL=https:\/\/integrate\.api\.nvidia\.com\/v1/);
  });

  it("does not apply an OpenAI base URL config to native NVIDIA providers", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "nvidia",
      "nvidia",
      "NVIDIA_INFERENCE_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      { NVIDIA_INFERENCE_API_KEY: "nvapi-staged" },
      (command) => {
        commands.push(command.join(" "));
        return command.includes("get")
          ? providerMetadata("nvidia", "nvidia", "NVIDIA_INFERENCE_API_KEY")
          : { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands[1]).not.toContain("--config");
  });

  it("fails before create when the credential value is empty", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "fresh-provider",
      "generic",
      "FRESH_TOKEN",
      null,
      {},
      (command) => {
        commands.push(command.join(" "));
        if (command.includes("get")) {
          return { status: 1, stdout: "", stderr: "provider 'fresh-provider' not found" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 1,
      message: "Provider credential input is missing or conflicts with imported credentials.",
    });
    expect(commands).toEqual(["provider get fresh-provider"]);
  });

  it("keeps --credential on the update path when a value is staged in env", async () => {
    const commands: string[] = [];
    await upsertProvider(
      "nvidia-prod",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      null,
      { NVIDIA_INFERENCE_API_KEY: "nvapi-staged" },
      (command) => {
        commands.push(command.join(" "));
        return command.includes("get")
          ? providerMetadata("nvidia-prod", "openai", "NVIDIA_INFERENCE_API_KEY")
          : { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatch(/^provider update nvidia-prod /);
    expect(commands[1]).toMatch(/--credential NVIDIA_INFERENCE_API_KEY/);
  });

  it("stages non-nvapi NVIDIA_INFERENCE_API_KEY as hosted custom inference", async () => {
    withProviderEnv(
      {
        NVIDIA_INFERENCE_API_KEY: "  repo-hosted-key  ",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(true);
        expect(getRequestedProviderHint(true)).toBe("custom");
        expect(getRequestedModelHint(true)).toBe(HOSTED_INFERENCE_MODEL);
        expect(process.env.NEMOCLAW_PROVIDER).toBe("custom");
        expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe(HOSTED_INFERENCE_ENDPOINT_URL);
        expect(process.env.NEMOCLAW_MODEL).toBe(HOSTED_INFERENCE_MODEL);
        expect(process.env.NEMOCLAW_COMPAT_MODEL).toBe(HOSTED_INFERENCE_MODEL);
        expect(process.env.NEMOCLAW_PREFERRED_API).toBe("openai-completions");
        expect(process.env.COMPATIBLE_API_KEY).toBe("repo-hosted-key");
      },
    );
  });

  it("does not synthesize hosted selection when authoritative resume disables staging", async () => {
    withProviderEnv(
      {
        NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
      },
      () => {
        expect(getRequestedProviderHint(true, false)).toBeNull();
        expect(getRequestedModelHint(true, false)).toBeNull();
        expect(process.env.NEMOCLAW_PROVIDER).toBeUndefined();
        expect(process.env.NEMOCLAW_MODEL).toBeUndefined();
        expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
      },
    );
  });

  it("supports the NVIDIA QA non-interactive provider-model contract (#6869)", async () => {
    withProviderEnv(
      {
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_PROVIDER_MODEL: "qwen3.6:35b",
      },
      () => {
        expect(getRequestedModelHint(true)).toBe("qwen3.6:35b");
      },
    );
  });

  it("keeps NEMOCLAW_MODEL ahead of NEMOCLAW_PROVIDER_MODEL", async () => {
    withProviderEnv(
      {
        NEMOCLAW_PROVIDER: "ollama",
        NEMOCLAW_MODEL: "qwen2.5:0.5b",
        NEMOCLAW_PROVIDER_MODEL: "qwen3.6:35b",
      },
      () => {
        expect(getRequestedModelHint(true)).toBe("qwen2.5:0.5b");
      },
    );
  });

  it("preserves NEMOCLAW_MODEL when the provider-model fallback is disabled", async () => {
    withProviderEnv(
      {
        NEMOCLAW_MODEL: "nvidia/nemotron-3-super-120b-a12b",
        NEMOCLAW_PROVIDER_MODEL: "fallback-model",
      },
      () => {
        expect(getNonInteractiveModel("openai", { allowProviderModelFallback: false })).toBe(
          "nvidia/nemotron-3-super-120b-a12b",
        );
      },
    );
  });

  it("omits NEMOCLAW_PROVIDER_MODEL when the provider-model fallback is disabled", async () => {
    withProviderEnv({ NEMOCLAW_PROVIDER_MODEL: "fallback-model" }, () => {
      expect(getNonInteractiveModel("openai", { allowProviderModelFallback: false })).toBeNull();
    });
  });

  it("stages Deep Agents NEMOCLAW_PROVIDER_KEY as hosted custom inference", async () => {
    withProviderEnv(
      {
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_PROVIDER_KEY: "  repo-hosted-key  ",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(true);
        expect(getRequestedProviderHint(true)).toBe("custom");
        expect(process.env.NEMOCLAW_PROVIDER).toBe("custom");
        expect(process.env.NEMOCLAW_ENDPOINT_URL).toBe(HOSTED_INFERENCE_ENDPOINT_URL);
        expect(process.env.NEMOCLAW_MODEL).toBe(HOSTED_INFERENCE_MODEL);
        expect(process.env.NEMOCLAW_COMPAT_MODEL).toBe(HOSTED_INFERENCE_MODEL);
        expect(process.env.COMPATIBLE_API_KEY).toBe("repo-hosted-key");
      },
    );
  });

  it("does not stage route-like Deep Agents NEMOCLAW_PROVIDER_KEY values as credentials", async () => {
    withProviderEnv(
      {
        NEMOCLAW_AGENT: "langchain-deepagents-code",
        NEMOCLAW_PROVIDER_KEY: "inference",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(false);
        expect(process.env.NEMOCLAW_PROVIDER).toBeUndefined();
        expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
      },
    );
  });

  it.each([
    ["sk-fallback-key", true],
    ["nvapi-fallback-key", true],
    [" build ", false],
    ["custom", false],
    ["inference", false],
    ["routed", false],
  ])("classifies provider-key compatibility bridge value %s", (value, expected) => {
    expect(isProviderKeyCredentialCandidate(value)).toBe(expected);
  });

  it.each(
    Array.from(
      new Set([
        "inference",
        ...Object.keys(NON_INTERACTIVE_PROVIDER_ALIASES),
        ...Array.from(NON_INTERACTIVE_PROVIDER_KEYS),
      ]),
      (value) => [value],
    ),
  )("rejects provider selector %s as a provider-key credential", (selector) => {
    expect(isProviderKeyCredentialCandidate(selector)).toBe(false);
  });

  it.each([
    "anthropic",
    "build",
    "cloud",
    "custom",
    "gemini",
    "hermes-provider",
    "inference",
    "install-ollama",
    "install-vllm",
    "nim-local",
    "ollama",
    "openai",
    "routed",
    "vllm",
  ])(
    "keeps Deep Agents provider-key selector %s from being staged as a credential",
    (providerKey) => {
      withProviderEnv(
        {
          NEMOCLAW_AGENT: "langchain-deepagents-code",
          NEMOCLAW_PROVIDER_KEY: providerKey,
        },
        () => {
          expect(stageHostedInferenceSourceSecretEnv()).toBe(false);
          expect(process.env.NEMOCLAW_PROVIDER).toBeUndefined();
          expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
        },
      );
    },
  );

  it("keeps generic NEMOCLAW_PROVIDER_KEY from implying hosted custom inference", async () => {
    withProviderEnv(
      {
        NEMOCLAW_PROVIDER_KEY: "repo-hosted-key",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(false);
        expect(process.env.NEMOCLAW_PROVIDER).toBeUndefined();
        expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
      },
    );
  });

  it("does not override an explicit hosted inference API preference", async () => {
    withProviderEnv(
      {
        NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
        NEMOCLAW_E2E_USE_HOSTED_INFERENCE: "1",
        NEMOCLAW_PREFERRED_API: "openai-responses",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(true);
        expect(process.env.NEMOCLAW_PREFERRED_API).toBe("openai-responses");
      },
    );
  });

  it("keeps explicit cloud provider selection on the Build provider path", async () => {
    withProviderEnv(
      {
        NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
        NEMOCLAW_PROVIDER: "cloud",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(false);
        expect(getRequestedProviderHint(true)).toBe("build");
        expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
        expect(process.env.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
      },
    );
  });

  it("preserves explicit custom provider credentials when NVIDIA_INFERENCE_API_KEY is unrelated", async () => {
    withProviderEnv(
      {
        COMPATIBLE_API_KEY: "custom-endpoint-key",
        NVIDIA_INFERENCE_API_KEY: "repo-hosted-key",
        NEMOCLAW_PROVIDER: "custom",
      },
      () => {
        expect(stageHostedInferenceSourceSecretEnv()).toBe(false);
        expect(getRequestedProviderHint(true)).toBe("custom");
        expect(process.env.COMPATIBLE_API_KEY).toBe("custom-endpoint-key");
        expect(process.env.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
      },
    );
  });

  it("returns redacted error details when create or update fails", async () => {
    const result = await upsertProvider(
      "bad-provider",
      "generic",
      "SOME_KEY",
      null,
      { SOME_KEY: "fake" },
      (command) => {
        if (command.includes("get")) {
          return { status: 1, stdout: "", stderr: "provider 'bad-provider' not found" };
        }
        return { status: 1, stdout: "", stderr: "gateway unreachable" };
      },
    );

    expect(result).toEqual({ ok: false, status: 1, message: "gateway unreachable" });
  });

  it("rechecks sandbox identity after a provider probe and before its mutation (#9833)", async () => {
    const commands: string[] = [];
    const revalidationSteps = [
      () => undefined,
      () => {
        throw new Error("sandbox identity changed after provider probe");
      },
    ];

    await expect(
      upsertProvider(
        "alpha-discord-bridge",
        "generic",
        "DISCORD_BOT_TOKEN",
        null,
        { DISCORD_BOT_TOKEN: "secret" },
        (command) => {
          commands.push(command.join(" "));
          return {
            status: 1,
            stdout: "",
            stderr: "provider 'alpha-discord-bridge' not found",
          };
        },
        { revalidateSandboxIdentity: () => revalidationSteps.shift()?.() },
      ),
    ).rejects.toThrow(/sandbox identity changed after provider probe/u);
    expect(commands).toEqual(["provider get alpha-discord-bridge"]);
  });

  it("rejects an existing generic provider when an exact credential binding is required", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
      null,
      { DISCORD_BOT_TOKEN: "discord-test" },
      (command) => {
        commands.push(command.join(" "));
        return {
          status: 0,
          stdout: [
            "Name: alpha-discord-bridge",
            "Type: generic",
            "Credential keys: DISCORD_BOT_TOKEN",
            "Config keys: <none>",
            "",
          ].join("\n"),
        };
      },
      { requireExactBinding: true },
    );

    expect(result).toEqual({
      ok: false,
      status: 1,
      reason: "binding-conflict",
      message:
        "Existing provider 'alpha-discord-bridge' does not match the required 'discord-hermes-static-v1' credential binding.",
    });
    expect(commands).toEqual(["provider get alpha-discord-bridge"]);
  });

  it("updates an existing provider when its exact credential binding matches", async () => {
    const commands: string[] = [];
    const result = await upsertProvider(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
      null,
      { DISCORD_BOT_TOKEN: "discord-test" },
      (command) => {
        commands.push(command.join(" "));
        return {
          status: 0,
          stdout: [
            "Name: alpha-discord-bridge",
            "Type: discord-hermes-static-v1",
            "Credential keys: DISCORD_BOT_TOKEN",
            "Config keys: <none>",
            "",
          ].join("\n"),
        };
      },
      { requireExactBinding: true },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toEqual([
      "provider get alpha-discord-bridge",
      "provider update alpha-discord-bridge --credential DISCORD_BOT_TOKEN",
    ]);
  });
});
