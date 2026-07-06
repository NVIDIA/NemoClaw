// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../../state/onboard-session.js");
const {
  isLocalInferenceProvider,
  getRebuildCredentialEnvFromRegistry,
  getRebuildEndpointFromRegistry,
  prepareRebuildResumeConfig,
} = requireDist("./rebuild-resume-config.js");

const noopLog = () => undefined;
const throwingBail = (msg: string): never => {
  throw new Error(msg);
};

function entry(overrides: Record<string, unknown> = {}) {
  return { name: "alpha", provider: null, model: null, nimContainer: null, ...overrides };
}

function snapshotEnv(names: readonly string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name] of saved) {
      delete process.env[name];
    }
    Object.assign(
      process.env,
      Object.fromEntries(
        saved.filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    );
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isLocalInferenceProvider", () => {
  it("classifies local providers and rejects remote/null", () => {
    expect(isLocalInferenceProvider("ollama-local")).toBe(true);
    expect(isLocalInferenceProvider("vllm-local")).toBe(true);
    expect(isLocalInferenceProvider("nvidia-prod")).toBe(false);
    expect(isLocalInferenceProvider(null)).toBe(false);
  });
});

describe("getRebuildCredentialEnvFromRegistry", () => {
  it("returns the canonical credential env for a known remote provider", () => {
    expect(getRebuildCredentialEnvFromRegistry("nvidia-prod")).toBe("NVIDIA_INFERENCE_API_KEY");
  });

  it("ignores recorded credentials for local providers and prefers canonical remote envs", () => {
    expect(getRebuildCredentialEnvFromRegistry("ollama-local", "OPENAI_API_KEY")).toBeNull();
    expect(getRebuildCredentialEnvFromRegistry("nvidia-prod", "OPENAI_API_KEY")).toBe(
      "NVIDIA_INFERENCE_API_KEY",
    );
  });

  it("uses canonical compatible credential envs and ignores stale recorded values", () => {
    expect(getRebuildCredentialEnvFromRegistry("compatible-endpoint", "COMPATIBLE_API_KEY")).toBe(
      "COMPATIBLE_API_KEY",
    );
    expect(
      getRebuildCredentialEnvFromRegistry(
        "compatible-anthropic-endpoint",
        "COMPATIBLE_ANTHROPIC_API_KEY",
      ),
    ).toBe("COMPATIBLE_ANTHROPIC_API_KEY");
    expect(getRebuildCredentialEnvFromRegistry("compatible-endpoint", "OPENAI_API_KEY")).toBe(
      "COMPATIBLE_API_KEY",
    );
    expect(getRebuildCredentialEnvFromRegistry("compatible-endpoint", "bad-name")).toBe(
      "COMPATIBLE_API_KEY",
    );
  });

  it("returns null for local and unset providers", () => {
    expect(getRebuildCredentialEnvFromRegistry("ollama-local")).toBeNull();
    expect(getRebuildCredentialEnvFromRegistry(null)).toBeNull();
  });
});

describe("getRebuildEndpointFromRegistry", () => {
  it("treats local and routed providers as derivable with no pinned URL", () => {
    expect(getRebuildEndpointFromRegistry("ollama-local")).toEqual({
      known: true,
      endpointUrl: null,
    });
    expect(getRebuildEndpointFromRegistry("nvidia-router")).toEqual({
      known: true,
      endpointUrl: null,
    });
    expect(getRebuildEndpointFromRegistry(null)).toEqual({ known: true, endpointUrl: null });
  });

  it("pins the canonical endpoint for a known remote provider", () => {
    const result = getRebuildEndpointFromRegistry("nvidia-prod");
    expect(result.known).toBe(true);
    expect(typeof result.endpointUrl).toBe("string");
    expect(result.endpointUrl.length).toBeGreaterThan(0);
  });

  it("marks a custom OpenAI-compatible provider as unknown without durable endpoint metadata", () => {
    expect(getRebuildEndpointFromRegistry("compatible-endpoint")).toEqual({ known: false });
  });

  it("uses canonical durable custom endpoint metadata from the sandbox registry", () => {
    expect(
      getRebuildEndpointFromRegistry(
        "compatible-endpoint",
        " http://127.0.0.1:19999/v1/?x=1#frag ",
      ),
    ).toEqual({
      known: true,
      endpointUrl: "http://127.0.0.1:19999/v1",
    });
  });

  it("rejects malformed or unsupported durable custom endpoint metadata", () => {
    expect(getRebuildEndpointFromRegistry("compatible-endpoint", "not-a-url")).toEqual({
      known: false,
    });
    expect(getRebuildEndpointFromRegistry("compatible-endpoint", "file:///tmp/x")).toEqual({
      known: false,
    });
    expect(
      getRebuildEndpointFromRegistry("compatible-endpoint", "https://u:p@example.test/v1"),
    ).toEqual({ known: false });
  });
});

describe("prepareRebuildResumeConfig", () => {
  it("preserves a stale Hermes API marker so rebuild re-arms provider setup (#6289)", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);

    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-anthropic-endpoint",
        model: "nvidia/nvidia/nemotron-3-super-v3",
        endpointUrl: "https://inference-api.nvidia.com",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      "hermes",
      noopLog,
      throwingBail,
    );

    expect(config).toMatchObject({
      agent: "hermes",
      provider: "compatible-anthropic-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
      endpointUrl: "https://inference-api.nvidia.com",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    });
  });

  it("preserves legacy OpenClaw custom Anthropic routes during rebuild (#6289)", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue(null);

    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
      null,
      noopLog,
      throwingBail,
    );

    expect(config?.preferredInferenceApi).toBe("anthropic-messages");
  });

  it("recovers a complete legacy selection only from the target's matching session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/legacy-model",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    const config = prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail);
    expect(config).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/legacy-model",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("surfaces the legacy local credential migration while clearing the stale key", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "ollama-local",
      model: "llama3.2",
      credentialEnv: "OPENAI_API_KEY",
    });
    const log = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "ollama-local", model: "llama3.2" }),
      null,
      log,
      throwingBail,
    );

    expect(config?.credentialEnv).toBeNull();
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("GH #2519"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("clearing for rebuild"));
  });

  it("fails closed when neither registry nor matching session has a complete selection", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    expect(() => prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail)).toThrow(
      "Cannot determine recorded inference provider and model",
    );
  });

  it("validates and canonicalizes a matching custom-endpoint session endpoint", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "m",
      endpointUrl: " http://127.0.0.1:19999/v1/?x=1#frag ",
    });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "compatible-endpoint", model: "m" }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config).toMatchObject({
      provider: "compatible-endpoint",
      model: "m",
      credentialEnv: "COMPATIBLE_API_KEY",
      pinEndpoint: false,
      endpointUrl: "http://127.0.0.1:19999/v1",
      registryInferenceRoute: null,
    });
  });

  it("prefers durable registry endpoint metadata over a stale matching session endpoint", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      endpointUrl: "https://stale.example.test/v1",
    });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: "https://registry.example.test/v1?x=1#frag",
        preferredInferenceApi: "openai-completions",
      }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config).toMatchObject({
      provider: "compatible-endpoint",
      model: "m",
      pinEndpoint: true,
      endpointUrl: "https://registry.example.test/v1",
    });
    expect(config?.registryInferenceRoute).toEqual({
      provider: "compatible-endpoint",
      model: "m",
      endpointUrl: "https://registry.example.test/v1",
      preferredInferenceApi: "openai-completions",
      source: "registry",
    });
  });

  it("ignores target-scoped explicit env when the custom-endpoint session matches the sandbox", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "m",
      endpointUrl: "https://session.example.test/v1?x=1#frag",
    });
    const restore = snapshotEnv([
      "NEMOCLAW_SANDBOX_NAME",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
    ]);
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "alpha";
      process.env.NEMOCLAW_PROVIDER = "custom";
      process.env.NEMOCLAW_ENDPOINT_URL = "https://env.example.test/v1";
      process.env.NEMOCLAW_MODEL = "m";
      const config = prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      );
      expect(config?.pinEndpoint).toBe(false);
      expect(config?.endpointUrl).toBe("https://session.example.test/v1");
    } finally {
      restore();
    }
  });

  it("fails closed for a matching custom-endpoint session with no recoverable endpoint", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot validate recreate endpoint");
  });

  it("fails closed for a matching custom-endpoint session with an invalid endpoint", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "m",
      endpointUrl: "https://user:pass@example.test/v1",
    });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot validate recreate endpoint");
  });

  it("does not borrow a custom endpoint from a conflicting same-sandbox selection", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "different-model",
      endpointUrl: "https://wrong.example.test/v1",
    });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot validate recreate endpoint");
  });

  it("pins the canonical endpoint when the session belongs to another sandbox", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "nvidia-prod", model: "m" }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config?.pinEndpoint).toBe(true);
    expect(typeof config?.endpointUrl).toBe("string");
  });

  it("fails closed for a custom endpoint with a non-matching session and no registry or explicit endpoint", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot determine recreate endpoint");
  });

  it("uses an explicit target-scoped endpoint for a custom endpoint with a non-matching session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const restore = snapshotEnv([
      "NEMOCLAW_SANDBOX_NAME",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
    ]);
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "alpha";
      process.env.NEMOCLAW_PROVIDER = "custom";
      process.env.NEMOCLAW_ENDPOINT_URL = " http://127.0.0.1:19999/v1/?x=1#frag ";
      process.env.NEMOCLAW_MODEL = "m";
      const config = prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m" }),
        null,
        noopLog,
        throwingBail,
      );
      expect(config).toMatchObject({
        provider: "compatible-endpoint",
        model: "m",
        pinEndpoint: true,
        endpointUrl: "http://127.0.0.1:19999/v1",
        registryInferenceRoute: null,
      });
    } finally {
      restore();
    }
  });

  it("accepts camelCase explicit provider aliases for non-matching session recovery", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const restore = snapshotEnv([
      "NEMOCLAW_SANDBOX_NAME",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
    ]);
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "alpha";
      process.env.NEMOCLAW_PROVIDER = "anthropicCompatible";
      process.env.NEMOCLAW_ENDPOINT_URL = "https://anthropic.example.test/v1?x=1#frag";
      process.env.NEMOCLAW_MODEL = "claude-like";
      const config = prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-anthropic-endpoint", model: "claude-like" }),
        null,
        noopLog,
        throwingBail,
      );
      expect(config).toMatchObject({
        provider: "compatible-anthropic-endpoint",
        model: "claude-like",
        pinEndpoint: true,
        endpointUrl: "https://anthropic.example.test/v1",
      });
    } finally {
      restore();
    }
  });

  it("rejects explicit target endpoints that do not exactly match the target boundary", () => {
    const cases = [
      { name: "wrong sandbox", sandboxName: "beta" },
      { name: "wrong provider", provider: "openai" },
      { name: "unknown provider", provider: "compatible-endpoint-alias" },
      { name: "missing model", model: "" },
      { name: "wrong model", model: "other-model" },
      { name: "unsupported url", endpointUrl: "file:///tmp/x" },
      { name: "userinfo url", endpointUrl: "https://u:p@example.test/v1" },
    ];
    for (const testCase of cases) {
      vi.restoreAllMocks();
      vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
      const restore = snapshotEnv([
        "NEMOCLAW_SANDBOX_NAME",
        "NEMOCLAW_PROVIDER",
        "NEMOCLAW_ENDPOINT_URL",
        "NEMOCLAW_MODEL",
      ]);
      try {
        process.env.NEMOCLAW_SANDBOX_NAME = testCase.sandboxName ?? "alpha";
        process.env.NEMOCLAW_PROVIDER = testCase.provider ?? "custom";
        process.env.NEMOCLAW_ENDPOINT_URL = testCase.endpointUrl ?? "https://env.example.test/v1";
        process.env.NEMOCLAW_MODEL = testCase.model ?? "m";
        expect(() =>
          prepareRebuildResumeConfig(
            "alpha",
            entry({ provider: "compatible-endpoint", model: "m" }),
            null,
            noopLog,
            throwingBail,
          ),
        ).toThrow("Cannot determine recreate endpoint");
      } finally {
        restore();
      }
    }
  });

  it("does not use an explicit endpoint when its sandbox name targets another sandbox", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const restore = snapshotEnv([
      "NEMOCLAW_SANDBOX_NAME",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_ENDPOINT_URL",
    ]);
    try {
      process.env.NEMOCLAW_SANDBOX_NAME = "beta";
      process.env.NEMOCLAW_PROVIDER = "custom";
      process.env.NEMOCLAW_ENDPOINT_URL = "http://127.0.0.1:19999/v1";
      expect(() =>
        prepareRebuildResumeConfig(
          "alpha",
          entry({ provider: "compatible-endpoint", model: "m" }),
          null,
          noopLog,
          throwingBail,
        ),
      ).toThrow("Cannot determine recreate endpoint");
    } finally {
      restore();
    }
  });

  it("recreates custom endpoints from durable registry metadata when the session is unrelated", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: "http://127.0.0.1:19999/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: "true",
      }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config).toMatchObject({
      provider: "compatible-endpoint",
      model: "m",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      pinEndpoint: true,
      endpointUrl: "http://127.0.0.1:19999/v1",
      registryInferenceRoute: {
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: "http://127.0.0.1:19999/v1",
        preferredInferenceApi: "openai-completions",
        source: "registry",
      },
    });
  });

  it("does not borrow compatible-endpoint reasoning from an unrelated session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "other",
      compatibleEndpointReasoning: "true",
    });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: "https://example.test/v1",
      }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config?.compatibleEndpointReasoning).toBeNull();
  });

  it("uses the target session as a legacy reasoning fallback", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      model: "m",
      compatibleEndpointReasoning: "false",
    });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: "https://example.test/v1",
      }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config?.compatibleEndpointReasoning).toBe("false");
  });

  it("fails closed for invalid durable custom endpoint metadata before delete", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    expect(() =>
      prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "compatible-endpoint", model: "m", endpointUrl: "not-a-url" }),
        null,
        noopLog,
        throwingBail,
      ),
    ).toThrow("Cannot determine recreate endpoint");
  });

  it("canonicalizes valid durable custom endpoint metadata before recreate", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "other" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({
        provider: "compatible-endpoint",
        model: "m",
        endpointUrl: " https://example.test/v1?x=1#frag ",
        credentialEnv: "COMPATIBLE_API_KEY",
      }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config?.endpointUrl).toBe("https://example.test/v1");
  });

  it("surfaces an ambient agent mismatch in the assessment", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
    const prior = process.env.NEMOCLAW_AGENT;
    process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
    try {
      const config = prepareRebuildResumeConfig(
        "alpha",
        entry({ provider: "nvidia-prod", model: "nvidia/test" }),
        null,
        noopLog,
        throwingBail,
      );
      expect(config?.ambient.agentMismatch).toEqual({
        envAgent: "langchain-deepagents-code",
        registryAgent: "openclaw",
      });
    } finally {
      // Branchless restore of prior worker value (ternary expression, not a
      // conditional statement, to keep the changed-test-file guardrail green).
      delete process.env.NEMOCLAW_AGENT;
      Object.assign(process.env, prior === undefined ? {} : { NEMOCLAW_AGENT: prior });
    }
  });
});
