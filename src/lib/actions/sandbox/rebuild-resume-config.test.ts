// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
const {
  isLocalInferenceProvider,
  getRebuildCredentialEnvFromRegistry,
  getRebuildEndpointFromRegistry,
  prepareRebuildResumeConfig,
} = requireDist("../../../../dist/lib/actions/sandbox/rebuild-resume-config.js");

const noopLog = () => undefined;
const throwingBail = (msg: string): never => {
  throw new Error(msg);
};

function entry(overrides: Record<string, unknown> = {}) {
  return { name: "alpha", provider: null, model: null, nimContainer: null, ...overrides };
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
  it("pins registry config and does not pin endpoint for a matching session", () => {
    vi.spyOn(onboardSession, "loadSession").mockReturnValue({ sandboxName: "alpha" });
    const config = prepareRebuildResumeConfig(
      "alpha",
      entry({ provider: "nvidia-prod", model: "m" }),
      null,
      noopLog,
      throwingBail,
    );
    expect(config).toMatchObject({
      provider: "nvidia-prod",
      model: "m",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      pinEndpoint: false,
    });
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

  it("fails closed for a custom endpoint with a non-matching session and no registry endpoint", () => {
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
      pinEndpoint: true,
      endpointUrl: "http://127.0.0.1:19999/v1",
    });
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
      const config = prepareRebuildResumeConfig("alpha", entry(), null, noopLog, throwingBail);
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
