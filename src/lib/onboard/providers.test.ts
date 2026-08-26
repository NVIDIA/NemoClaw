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

const messagingBridgeProvider = require(
  "./messaging-bridge-provider"
) as typeof import("./messaging-bridge-provider");

const DISCORD_STATIC_PROFILE_EXPORT = JSON.stringify({
  id: "discord-hermes-static-v1",
  credentials: [
    {
      name: "bot_token",
      env_vars: ["DISCORD_BOT_TOKEN"],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

const MESSAGING_ENDPOINTLESS_PROFILE_EXPORT = JSON.stringify({
  id: "nemoclaw-mcp-v1",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

const {
  HOSTED_INFERENCE_ENDPOINT_URL,
  HOSTED_INFERENCE_MODEL,
  NON_INTERACTIVE_PROVIDER_ALIASES,
  NON_INTERACTIVE_PROVIDER_KEYS,
  REMOTE_PROVIDER_CONFIG,
  buildProviderArgs,
  getNonInteractiveProvider,
  getNonInteractiveModel,
  getRequestedModelHint,
  getRequestedProviderHint,
  isProviderKeyCredentialCandidate,
  providerExistsInGateway,
  stageHostedInferenceSourceSecretEnv,
  upsertProvider,
  upsertMessagingProviders,
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
  buildProviderArgs: (
    action: "create" | "update",
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
  ) => string[];
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
  providerExistsInGateway: (name: string, runOpenshell: RunOpenshell) => boolean;
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
      revalidatePolicyRequirements?(operation: string): void;
    },
  ) => { ok: boolean; status?: number; message?: string; reason?: string };
  upsertMessagingProviders: (
    tokenDefs: Array<{
      name: string;
      envKey: string;
      token: string | null;
      providerType?: string;
    }>,
    runOpenshell: RunOpenshell,
    options?: {
      allowedSandboxes?: readonly string[];
      bestEffort?: boolean;
      replaceExisting?: boolean;
      revalidatePolicyRequirements?(operation: string): void;
      requireExactBindings?: boolean;
    },
  ) => string[];
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
  it("uses Gemini 3.6 Flash as the onboarding default (#9298)", () => {
    expect(REMOTE_PROVIDER_CONFIG.gemini.defaultModel).toBe("gemini-3.6-flash");
  });

  it("keeps managed llama.cpp as a public non-interactive provider selector (#8433)", () => {
    expect(NON_INTERACTIVE_PROVIDER_KEYS.has("install-llama-cpp")).toBe(true);
    withProviderEnv({ NEMOCLAW_PROVIDER: "install-llama-cpp" }, () => {
      expect(getNonInteractiveProvider(false)).toBe("install-llama-cpp");
    });
  });

  it("registers OpenRouter with an OpenAI-compatible provider profile and aliases (#5826)", () => {
    const provider = REMOTE_PROVIDER_CONFIG.openrouter;

    expect(provider).toMatchObject({
      providerName: "openrouter-api",
      providerType: "openai",
      credentialEnv: "OPENROUTER_API_KEY",
    });
    expect(NON_INTERACTIVE_PROVIDER_KEYS.has("openrouter")).toBe(true);
    expect(NON_INTERACTIVE_PROVIDER_ALIASES["open-router"]).toBe("openrouter");
    expect(NON_INTERACTIVE_PROVIDER_ALIASES.openrouterai).toBe("openrouter");
    expect(
      buildProviderArgs(
        "create",
        provider.providerName,
        provider.providerType,
        provider.credentialEnv,
        "https://openrouter.ai/api/v1",
      ),
    ).toContain("OPENAI_BASE_URL=https://openrouter.ai/api/v1");
  });

  it("keeps the discovery profile Anthropic before agent-specific surface selection (#6289)", () => {
    const provider = REMOTE_PROVIDER_CONFIG.anthropicCompatible;

    // Remote provider setup can replace this registration with type=openai
    // after an agent selects and verifies the endpoint's OpenAI surface.
    expect(provider).toMatchObject({
      providerName: "compatible-anthropic-endpoint",
      providerType: "anthropic",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    });
    expect(
      buildProviderArgs(
        "create",
        provider.providerName,
        provider.providerType,
        provider.credentialEnv,
        "https://inference-api.nvidia.com",
      ),
    ).toContain("ANTHROPIC_BASE_URL=https://inference-api.nvidia.com");
  });

  it("builds create arguments for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
    );
    expect(args).toEqual([
      "provider",
      "create",
      "--name",
      "discord-bridge",
      "--type",
      "generic",
      "--credential",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("builds update arguments", () => {
    const args = buildProviderArgs(
      "update",
      "inference",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      null,
    );
    expect(args).toEqual([
      "provider",
      "update",
      "inference",
      "--credential",
      "NVIDIA_INFERENCE_API_KEY",
    ]);
  });

  it("appends OPENAI_BASE_URL config for openai providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://api.example.com/v1",
    );
    expect(args).toContain("--config");
    expect(args).toContain("OPENAI_BASE_URL=https://api.example.com/v1");
  });

  it("appends ANTHROPIC_BASE_URL config for anthropic providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "anthropic",
      "ANTHROPIC_API_KEY",
      "https://api.anthropic.example.com",
    );
    expect(args).toContain("--config");
    expect(args).toContain("ANTHROPIC_BASE_URL=https://api.anthropic.example.com");
  });

  it("ignores base URL for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "slack-bridge",
      "generic",
      "SLACK_BOT_TOKEN",
      "https://ignored.example.com",
    );
    expect(args).not.toContain("--config");
  });

  it("checks whether providers exist in the gateway", () => {
    expect(providerExistsInGateway("discord-bridge", () => ({ status: 0 }))).toBe(true);
    expect(providerExistsInGateway("missing-bridge", () => ({ status: 1 }))).toBe(false);
  });

  it("creates a new provider and returns ok on success", () => {
    const commands: string[] = [];
    const result = upsertProvider(
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
      { DISCORD_BOT_TOKEN: "fake" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        if (normalized.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/provider create --name discord-bridge/);
    expect(commands[1]).toMatch(/--credential DISCORD_BOT_TOKEN/);
  });

  it("does not add its own log line on top of runner output (#1506)", () => {
    let stdoutWrites = 0;
    const result = upsertProvider(
      "test-bridge",
      "generic",
      "TEST_TOKEN",
      null,
      { TEST_TOKEN: "tok" },
      (command) => {
        if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
        stdoutWrites += 1;
        return { status: 0, stdout: "✓ Created provider test-bridge", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(stdoutWrites).toBe(1);
  });

  it("updates existing providers instead of creating (#1155)", () => {
    const commands: string[] = [];
    const result = upsertProvider(
      "inference",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      {},
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
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

  it("omits --credential from the update args when the env value is empty", () => {
    const commands: string[] = [];
    const result = upsertProvider(
      "nvidia-prod",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      {},
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
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

  it("keeps --credential on the create path even when env is empty", () => {
    // create cannot omit credentials — OpenShell rejects empty credential
    // maps on creation. The caller is responsible for staging a value.
    const commands: string[] = [];
    upsertProvider("fresh-provider", "generic", "FRESH_TOKEN", null, {}, (command) => {
      commands.push(command.join(" "));
      if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    });

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatch(/^provider create --name fresh-provider /);
    expect(commands[1]).toMatch(/--credential FRESH_TOKEN/);
  });

  it("keeps --credential on the update path when a value is staged in env", () => {
    const commands: string[] = [];
    upsertProvider(
      "nvidia-prod",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      null,
      { NVIDIA_INFERENCE_API_KEY: "nvapi-staged" },
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatch(/^provider update nvidia-prod /);
    expect(commands[1]).toMatch(/--credential NVIDIA_INFERENCE_API_KEY/);
  });

  it("stages non-nvapi NVIDIA_INFERENCE_API_KEY as hosted custom inference", () => {
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

  it("does not synthesize hosted selection when authoritative resume disables staging", () => {
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

  it("supports the NVIDIA QA non-interactive provider-model contract (#6869)", () => {
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

  it("keeps NEMOCLAW_MODEL ahead of NEMOCLAW_PROVIDER_MODEL", () => {
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

  it("preserves NEMOCLAW_MODEL when the provider-model fallback is disabled", () => {
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

  it("omits NEMOCLAW_PROVIDER_MODEL when the provider-model fallback is disabled", () => {
    withProviderEnv({ NEMOCLAW_PROVIDER_MODEL: "fallback-model" }, () => {
      expect(getNonInteractiveModel("openai", { allowProviderModelFallback: false })).toBeNull();
    });
  });

  it("stages Deep Agents NEMOCLAW_PROVIDER_KEY as hosted custom inference", () => {
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

  it("does not stage route-like Deep Agents NEMOCLAW_PROVIDER_KEY values as credentials", () => {
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

  it("keeps generic NEMOCLAW_PROVIDER_KEY from implying hosted custom inference", () => {
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

  it("does not override an explicit hosted inference API preference", () => {
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

  it("keeps explicit cloud provider selection on the Build provider path", () => {
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

  it("preserves explicit custom provider credentials when NVIDIA_INFERENCE_API_KEY is unrelated", () => {
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

  it("returns redacted error details when create or update fails", () => {
    const result = upsertProvider("bad-provider", "generic", "SOME_KEY", null, {}, (command) => {
      if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "gateway unreachable" };
    });

    expect(result).toEqual({ ok: false, status: 1, message: "gateway unreachable" });
  });

  it("creates Brave Search providers with the Brave provider profile", () => {
    const commands: string[] = [];
    const providers = upsertMessagingProviders(
      [
        {
          name: "alpha-brave-search",
          envKey: "BRAVE_API_KEY",
          token: "brv-test",
          providerType: "brave",
        },
      ],
      (command) => {
        commands.push(command.join(" "));
        if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(providers).toEqual(["alpha-brave-search"]);
    expect(commands).toContain("provider get alpha-brave-search");
    expect(commands).toContain(
      "provider create --name alpha-brave-search --type brave --credential BRAVE_API_KEY",
    );
  });

  it("imports the endpointless profile before creating a static messaging provider (#9875)", () => {
    const credential = "discord-credential-must-not-leak";
    const calls: Array<{ command: string[]; env?: Record<string, string | undefined> }> = [];
    let created = false;
    const providers = upsertMessagingProviders(
      [
        {
          name: "alpha-discord-bridge",
          envKey: "DISCORD_BOT_TOKEN",
          token: credential,
          providerType: "nemoclaw-mcp-v1",
        },
      ],
      (command, options) => {
        calls.push({ command, env: options?.env });
        switch (command[1]) {
          case "profile":
            return command.includes("export")
              ? { status: 1, stdout: "", stderr: "provider profile not found" }
              : { status: 0, stdout: "", stderr: "" };
          case "get":
            return created
              ? {
                  status: 0,
                  stdout:
                    "Name: alpha-discord-bridge\nType: nemoclaw-mcp-v1\nCredential keys: DISCORD_BOT_TOKEN\nConfig keys: <none>\n",
                }
              : {
                  status: 1,
                  stdout: "",
                  stderr: "provider 'alpha-discord-bridge' not found",
                };
          case "create":
            created = true;
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(providers).toEqual(["alpha-discord-bridge"]);
    expect(calls.map(({ command }) => command.join(" "))).toEqual([
      "provider profile export nemoclaw-mcp-v1 --output json",
      expect.stringMatching(/^provider profile import --file .*nemoclaw-mcp-v1\.yaml$/),
      "provider get alpha-discord-bridge",
      "provider create --name alpha-discord-bridge --type nemoclaw-mcp-v1 --credential DISCORD_BOT_TOKEN",
      "provider get alpha-discord-bridge",
    ]);
    expect(calls[3]?.env).toEqual({ DISCORD_BOT_TOKEN: credential });
    expect(calls.flatMap(({ command }) => command)).not.toContain(credential);
  });

  it("rejects credential-free reuse when the messaging profile is incompatible (#9875)", () => {
    const commands: string[] = [];
    const profileResults: Record<string, RunResult> = {
      export: {
        status: 0,
        stdout: JSON.stringify({
          id: "nemoclaw-mcp-v1",
          credentials: [],
          endpoints: [{ url: "https://foreign.example" }],
          binaries: [],
          inference_capable: false,
        }),
        stderr: "",
      },
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: null,
            providerType: "nemoclaw-mcp-v1",
          },
        ],
        (command) => {
          const joined = command.join(" ");
          commands.push(joined);
          return profileResults[command[2] ?? ""] ?? { status: 0, stdout: "", stderr: "" };
        },
        { bestEffort: true },
      ),
    ).toThrow(/does not match NemoClaw's endpointless messaging credential contract/u);
    expect(commands).toEqual(["provider profile export nemoclaw-mcp-v1 --output json"]);
  });

  it.each([
    ["alpha-discord-bridge", "DISCORD_BOT_TOKEN"],
    ["alpha-slack-bridge", "SLACK_BOT_TOKEN"],
  ])("rejects a live legacy provider before updating %s (#9875)", (name, credentialKey) => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name,
            envKey: credentialKey,
            token: "test-only-messaging-credential",
            providerType: "nemoclaw-mcp-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command[1] === "profile"
            ? { status: 0, stdout: MESSAGING_ENDPOINTLESS_PROFILE_EXPORT }
            : {
                status: 0,
                stdout: `Name: ${name}\nType: generic\nCredential keys: ${credentialKey}\nConfig keys: <none>\n`,
              };
        },
        { bestEffort: true },
      ),
    ).toThrow(/does not match the required endpointless credential binding/);
    expect(commands.some((command) => /provider (create|update)/u.test(command))).toBe(false);
  });

  it("rejects an ambiguous messaging provider lookup before mutation (#9875)", () => {
    const mutations: string[] = [];
    const getResult = {
      status: 1,
      stdout: "",
      stderr: 'Error: status: Unavailable, message: "provider not found"',
    };
    const profileResult = {
      status: 0,
      stdout: MESSAGING_ENDPOINTLESS_PROFILE_EXPORT,
      stderr: "",
    };

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "credential",
            providerType: "nemoclaw-mcp-v1",
          },
        ],
        (command) => {
          const joined = command.join(" ");
          const result = joined.startsWith("provider profile ")
            ? profileResult
            : new Map([["provider get alpha-discord-bridge", getResult]]).get(joined);
          mutations.push(...(result ? [] : [joined]));
          return result ?? profileResult;
        },
        { bestEffort: true },
      ),
    ).toThrow(/Could not inspect messaging provider/);
    expect(mutations).toEqual([]);
  });

  it.each([
    ["alpha-discord-bridge", "DISCORD_BOT_TOKEN"],
    ["alpha-slack-bridge", "SLACK_BOT_TOKEN"],
  ])("replaces a detached legacy provider before registering %s (#9875)", (name, credentialKey) => {
    const commands: string[] = [];
    let providerType = "generic";
    const providers = upsertMessagingProviders(
      [
        {
          name,
          envKey: credentialKey,
          token: "test-only-messaging-credential",
          providerType: "nemoclaw-mcp-v1",
        },
      ],
      (command) => {
        commands.push(command.join(" "));
        switch (command[1]) {
          case "profile":
            return { status: 0, stdout: MESSAGING_ENDPOINTLESS_PROFILE_EXPORT };
          case "delete":
            return { status: 0 };
          case "create":
            providerType = "nemoclaw-mcp-v1";
            return { status: 0 };
          default:
            return {
              status: 0,
              stdout: `Name: ${name}\nType: ${providerType}\nCredential keys: ${credentialKey}\nConfig keys: <none>\n`,
            };
        }
      },
      { replaceExisting: true },
    );

    expect(providers).toEqual([name]);
    expect(commands).toEqual([
      "provider profile export nemoclaw-mcp-v1 --output json",
      `provider get ${name}`,
      `provider delete ${name}`,
      `provider create --name ${name} --type nemoclaw-mcp-v1 --credential ${credentialKey}`,
      `provider get ${name}`,
    ]);
  });

  it("updates an existing Brave Search provider in place on reuse paths", () => {
    const commands: string[] = [];
    const providers = upsertMessagingProviders(
      [
        {
          name: "alpha-brave-search",
          envKey: "BRAVE_API_KEY",
          token: "brv-test",
          providerType: "brave",
        },
      ],
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    // No `provider delete` — OpenShell rejects deleting providers that are
    // still attached to a live sandbox, so reuse paths must use `update`.
    expect(providers).toEqual(["alpha-brave-search"]);
    expect(commands).toEqual([
      "provider get alpha-brave-search",
      "provider update alpha-brave-search --credential BRAVE_API_KEY",
    ]);
  });

  it("revalidates policy requirements before each messaging provider mutation (#9833)", () => {
    const commands: string[] = [];
    const revalidationSteps = [
      () => undefined,
      () => undefined,
      () => {
        throw new Error("policy authority changed between providers");
      },
    ];

    expect(() =>
      upsertMessagingProviders(
        [
          { name: "alpha-first", envKey: "FIRST_TOKEN", token: "first" },
          { name: "alpha-second", envKey: "SECOND_TOKEN", token: "second" },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command.includes("get")
            ? { status: 1, stdout: "", stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        },
        { revalidatePolicyRequirements: () => revalidationSteps.shift()?.() },
      ),
    ).toThrow(/authority changed between providers/);
    expect(commands).toEqual([
      "provider get alpha-first",
      "provider create --name alpha-first --type generic --credential FIRST_TOKEN",
    ]);
  });

  it("rechecks policy authority after a provider probe and before its mutation (#9833)", () => {
    const commands: string[] = [];
    const revalidationSteps = [
      () => undefined,
      () => {
        throw new Error("policy authority changed after provider probe");
      },
    ];

    expect(() =>
      upsertProvider(
        "alpha-discord-bridge",
        "generic",
        "DISCORD_BOT_TOKEN",
        null,
        { DISCORD_BOT_TOKEN: "secret" },
        (command) => {
          commands.push(command.join(" "));
          return { status: 1, stdout: "", stderr: "not found" };
        },
        { revalidatePolicyRequirements: () => revalidationSteps.shift()?.() },
      ),
    ).toThrow(/authority changed after provider probe/u);
    expect(commands).toEqual(["provider get alpha-discord-bridge"]);
  });

  it("rejects an existing generic provider when an exact credential binding is required", () => {
    const commands: string[] = [];
    const result = upsertProvider(
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
    expect(commands).toEqual([
      "provider get alpha-discord-bridge",
      "provider get alpha-discord-bridge",
    ]);
  });

  it("updates an existing provider when its exact credential binding matches", () => {
    const commands: string[] = [];
    const result = upsertProvider(
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
      "provider get alpha-discord-bridge",
      "provider update alpha-discord-bridge --credential DISCORD_BOT_TOKEN",
    ]);
  });


  it("throws instead of exiting when best-effort messaging provider upsert fails", () => {
    const originalExit = process.exit;
    process.exit = ((code?: number | string | null) => {
      throw new Error(`unexpected process.exit(${code ?? 0})`);
    }) as typeof process.exit;
    try {
      expect(() =>
        upsertMessagingProviders(
          [
            {
              name: "telegram-bridge",
              envKey: "TELEGRAM_BOT_TOKEN",
              token: "tg-test",
            },
          ],
          (command) => {
            if (command.includes("get")) return { status: 0, stdout: "", stderr: "" };
            return { status: 1, stdout: "", stderr: "gateway unavailable" };
          },
          { bestEffort: true },
        ),
      ).toThrow(/telegram-bridge: gateway unavailable/);
    } finally {
      process.exit = originalExit;
    }
  });

  it("reports providers changed before bridge refresh throws (#9833)", () => {
    const configureRefreshes = vi
      .spyOn(messagingBridgeProvider, "configureMessagingBridgeRefreshes")
      .mockImplementation(() => {
        throw new Error("policy authority changed");
      });
    try {
      expect(() =>
        upsertMessagingProviders(
          [{ name: "alpha-bridge", envKey: "BRIDGE_TOKEN", token: "test-token" }],
          () => ({ status: 0, stdout: "", stderr: "" }),
          { bestEffort: true },
        ),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/policy authority changed.*alpha-bridge/isu),
          mutatedProviderNames: ["alpha-bridge"],
        }),
      );
    } finally {
      configureRefreshes.mockRestore();
    }
  });

  it("reports providers changed before bridge refresh returns failure (#9833)", () => {
    const configureRefreshes = vi
      .spyOn(messagingBridgeProvider, "configureMessagingBridgeRefreshes")
      .mockReturnValue({ ok: false, reason: "refresh failed" });
    try {
      expect(() =>
        upsertMessagingProviders(
          [{ name: "alpha-bridge", envKey: "BRIDGE_TOKEN", token: "test-token" }],
          () => ({ status: 0, stdout: "", stderr: "" }),
          { bestEffort: true },
        ),
      ).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/token minting.*alpha-bridge/isu),
          mutatedProviderNames: ["alpha-bridge"],
        }),
      );
    } finally {
      configureRefreshes.mockRestore();
    }
  });

  it("classifies an exact-binding conflict without mutating the existing provider", () => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command.includes("profile") && command.includes("export")
            ? { status: 0, stdout: DISCORD_STATIC_PROFILE_EXPORT }
            : {
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
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      }),
    );
    expect(commands).not.toContain(
      "provider update alpha-discord-bridge --credential DISCORD_BOT_TOKEN",
    );
  });

  it("preflights every exact binding before creating any messaging provider", () => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "alpha-discord-test",
            providerType: "discord-hermes-static-v1",
          },
          {
            name: "beta-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: "beta-discord-test",
            providerType: "discord-hermes-static-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return command[1] === "get" && command[2] === "alpha-discord-bridge"
            ? { status: 1, stdout: "", stderr: "not found" }
            : {
                status: 0,
                stdout: [
                  "Name: beta-discord-bridge",
                  "Type: generic",
                  "Credential keys: DISCORD_BOT_TOKEN",
                  "Config keys: <none>",
                  "",
                ].join("\n"),
              };
        },
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      }),
    );
    expect(commands).not.toContain(
      "provider create --name alpha-discord-bridge --type discord-hermes-static-v1 --credential DISCORD_BOT_TOKEN",
    );
    expect(commands.some((command) => command.includes("provider create"))).toBe(false);
    expect(commands.some((command) => command.includes("provider update"))).toBe(false);
    expect(commands.some((command) => command.includes("profile import"))).toBe(false);
  });

  it("replaces existing providers when the caller opts in (post-sandbox-delete path)", () => {
    const commands: string[] = [];
    // replaceExisting: true is only safe after the sandbox holding the
    // provider has been deleted. Used to migrate legacy generic-typed
    // Brave providers to the brave profile on `--recreate-sandbox`.
    const providers = upsertMessagingProviders(
      [
        {
          name: "alpha-brave-search",
          envKey: "BRAVE_API_KEY",
          token: "brv-test",
          providerType: "brave",
        },
      ],
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
      { replaceExisting: true },
    );

    expect(providers).toEqual(["alpha-brave-search"]);
    expect(commands).toEqual([
      "provider get alpha-brave-search",
      "provider delete alpha-brave-search",
      "provider create --name alpha-brave-search --type brave --credential BRAVE_API_KEY",
    ]);
  });

  it("recovers from FailedPrecondition by detaching stale sandboxes and retrying delete", () => {
    const commands: string[] = [];
    let deleteAttempt = 0;
    const providers = upsertMessagingProviders(
      [
        {
          name: "spark-nemo-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "tg-test",
          providerType: "generic",
        },
      ],
      (command) => {
        const joined = command.join(" ");
        commands.push(joined);
        if (joined === "provider get spark-nemo-telegram-bridge") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (joined === "provider delete spark-nemo-telegram-bridge") {
          deleteAttempt += 1;
          if (deleteAttempt === 1) {
            return {
              status: 1,
              stdout: "",
              stderr:
                "Error: \xc3\x97 status: FailedPrecondition, message: \"provider 'spark-nemo-telegram-bridge' is attached to sandbox(es): spark-nemo\"",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      { replaceExisting: true },
    );

    expect(providers).toEqual(["spark-nemo-telegram-bridge"]);
    expect(commands).toEqual([
      "provider get spark-nemo-telegram-bridge",
      "provider delete spark-nemo-telegram-bridge",
      "sandbox provider detach spark-nemo spark-nemo-telegram-bridge",
      "provider delete spark-nemo-telegram-bridge",
      "provider create --name spark-nemo-telegram-bridge --type generic --credential TELEGRAM_BOT_TOKEN",
    ]);
  });

  it("does not detach a sibling sandbox while replacing a recreate-owned provider (#9875)", () => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "spark-nemo-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: "tg-test",
            providerType: "generic",
          },
        ],
        (command) => {
          const joined = command.join(" ");
          commands.push(joined);
          return joined === "provider delete spark-nemo-telegram-bridge"
            ? {
                status: 1,
                stdout: "",
                stderr:
                  "Error: status: FailedPrecondition, message: \"provider 'spark-nemo-telegram-bridge' is attached to sandbox(es): sibling-live\"",
              }
            : { status: 0, stdout: "", stderr: "" };
        },
        {
          replaceExisting: true,
          bestEffort: true,
          allowedSandboxes: ["spark-nemo"],
        },
      ),
    ).toThrow(/sibling-live/u);
    expect(commands).toEqual([
      "provider get spark-nemo-telegram-bridge",
      "provider delete spark-nemo-telegram-bridge",
    ]);
  });

  it("surfaces detach failures in the final error when delete retry still fails", () => {
    let originalExit: typeof process.exit = process.exit;
    let captured = "";
    const captureErr = (() => {
      const original = console.error;
      console.error = (msg: string) => {
        captured += `${msg}\n`;
      };
      return () => {
        console.error = original;
      };
    })();
    process.exit = ((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as never;
    try {
      expect(() =>
        upsertMessagingProviders(
          [
            {
              name: "ghost-nemo-telegram-bridge",
              envKey: "TELEGRAM_BOT_TOKEN",
              token: "tg-test",
              providerType: "generic",
            },
          ],
          (command) => {
            const joined = command.join(" ");
            if (joined === "provider get ghost-nemo-telegram-bridge") {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (joined === "provider delete ghost-nemo-telegram-bridge") {
              return {
                status: 1,
                stdout: "",
                stderr:
                  "Error: status: FailedPrecondition, message: \"provider 'ghost-nemo-telegram-bridge' is attached to sandbox(es): ghost-nemo\"",
              };
            }
            if (joined === "sandbox provider detach ghost-nemo ghost-nemo-telegram-bridge") {
              return { status: 1, stdout: "", stderr: "Error: gateway unreachable" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
          { replaceExisting: true },
        ),
      ).toThrow(/exit\(1\)/);
      expect(captured).toContain("ghost-nemo-telegram-bridge");
      expect(captured).toContain("detach failures");
      expect(captured).toContain("ghost-nemo");
      expect(captured).toContain("gateway unreachable");
    } finally {
      process.exit = originalExit;
      captureErr();
    }
  });
});
