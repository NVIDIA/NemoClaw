// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AMBIENT_RECREATE_ENV_VARS,
  assessAmbientRecreateEnv,
  isolateAmbientRecreateEnv,
  sanitizeEnvValueForDisplay,
} from "./rebuild-env-isolation.js";

describe("sanitizeEnvValueForDisplay PRA-7 (#5735)", () => {
  it("collapses a multi-line / ANSI value into a single safe line", () => {
    // Untrusted NEMOCLAW_AGENT with a newline + CR + ANSI escape that tries to
    // paint a fake "Installation complete" status line.
    const malicious = "deepagents\n\u001b[2K\rInstallation complete \u001b[32mOK\u001b[0m";
    const out = sanitizeEnvValueForDisplay(malicious);
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\u001b"); // ESC stripped — no ANSI sequence survives
    expect(out).toContain("deepagents"); // visible text preserved on one line
  });

  it("strips control characters and trims/collapses whitespace", () => {
    expect(sanitizeEnvValueForDisplay("a\tb\u0000c   d")).toBe("a b c d");
    expect(sanitizeEnvValueForDisplay("  spaced  ")).toBe("spaced");
  });

  it("caps overly long values with an ellipsis", () => {
    const out = sanitizeEnvValueForDisplay("x".repeat(200), 80);
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("AMBIENT_RECREATE_ENV_VARS contract PRA-4 (#5735)", () => {
  it("pins the exact onboard-selection env set the recreate must isolate", () => {
    // Mirrors the ambient selection env vars `onboard --resume` reads at its
    // source boundary. Adding a new onboard-selection env var must be a conscious
    // change here too, or rebuild recreates could be re-contaminated by an
    // unrelated onboard. Keep in sync with the documented source reads in
    // rebuild-env-isolation.ts.
    expect([...AMBIENT_RECREATE_ENV_VARS]).toEqual([
      "NEMOCLAW_AGENT",
      "NEMOCLAW_PROVIDER",
      "NEMOCLAW_PROVIDER_KEY",
      "NEMOCLAW_ENDPOINT_URL",
      "NEMOCLAW_MODEL",
      "NEMOCLAW_COMPAT_MODEL",
      "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
      "NEMOCLAW_PREFERRED_API",
      "NEMOCLAW_REASONING",
      "NEMOCLAW_VLLM_MODEL",
      "NEMOCLAW_VLLM_EXTRA_ARGS_JSON",
      "NEMOCLAW_FROM_DOCKERFILE",
      "NEMOCLAW_WEB_SEARCH_PROVIDER",
      "NEMOCLAW_POLICY_TIER",
      "NEMOCLAW_POLICY_MODE",
      "NEMOCLAW_POLICY_PRESETS",
      "NEMOCLAW_SANDBOX_GPU",
      "NEMOCLAW_SANDBOX_GPU_DEVICE",
      "NEMOCLAW_TOOL_DISCLOSURE",
    ]);
  });
});

describe("assessAmbientRecreateEnv", () => {
  it("reports no contamination when no ambient onboard env is set", () => {
    const result = assessAmbientRecreateEnv("openclaw", {});
    expect(result.presentVars).toEqual([]);
    expect(result.agentMismatch).toBeNull();
  });

  it("flags an ambient NEMOCLAW_AGENT that differs from the registry agent", () => {
    const result = assessAmbientRecreateEnv("openclaw", {
      NEMOCLAW_AGENT: "langchain-deepagents-code",
      NEMOCLAW_PROVIDER_KEY: "sk-bogus",
      NEMOCLAW_PREFERRED_API: "chat-completions",
      NEMOCLAW_REASONING: "true",
    });
    expect(result.presentVars).toEqual([
      "NEMOCLAW_AGENT",
      "NEMOCLAW_PROVIDER_KEY",
      "NEMOCLAW_PREFERRED_API",
      "NEMOCLAW_REASONING",
    ]);
    expect(result.agentMismatch).toEqual({
      envAgent: "langchain-deepagents-code",
      registryAgent: "openclaw",
    });
  });

  it("treats a null registry agent as the default OpenClaw runtime", () => {
    const result = assessAmbientRecreateEnv(null, { NEMOCLAW_AGENT: "hermes" });
    expect(result.agentMismatch).toEqual({ envAgent: "hermes", registryAgent: "openclaw" });
  });

  it("does not flag a mismatch when ambient NEMOCLAW_AGENT matches the registry", () => {
    const result = assessAmbientRecreateEnv("hermes", { NEMOCLAW_AGENT: "hermes" });
    expect(result.agentMismatch).toBeNull();
    expect(result.presentVars).toEqual(["NEMOCLAW_AGENT"]);
  });

  it("ignores empty/whitespace env values", () => {
    const result = assessAmbientRecreateEnv("openclaw", {
      NEMOCLAW_AGENT: "   ",
      NEMOCLAW_MODEL: "",
    });
    expect(result.presentVars).toEqual([]);
    expect(result.agentMismatch).toBeNull();
  });
});

describe("isolateAmbientRecreateEnv", () => {
  it("removes ambient selection vars and restores the originals (including unset)", () => {
    const env: NodeJS.ProcessEnv = {
      NEMOCLAW_AGENT: "langchain-deepagents-code",
      NEMOCLAW_PROVIDER_KEY: "sk-bogus",
      NEMOCLAW_MODEL: "some-model",
      NEMOCLAW_COMPAT_MODEL: "some-compat-model",
      NEMOCLAW_PREFERRED_API: "openai-responses",
      NEMOCLAW_REASONING: "false",
      NEMOCLAW_VLLM_MODEL: "ambient-vllm-model",
      NEMOCLAW_VLLM_EXTRA_ARGS_JSON: '{"ambient":true}',
      NEMOCLAW_FROM_DOCKERFILE: "/tmp/unrelated.Dockerfile",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
      NEMOCLAW_POLICY_TIER: "permissive",
      NEMOCLAW_POLICY_MODE: "customize",
      NEMOCLAW_POLICY_PRESETS: "ambient-preset",
      NEMOCLAW_SANDBOX_GPU: "0",
      NEMOCLAW_SANDBOX_GPU_DEVICE: "9",
      NVIDIA_INFERENCE_API_KEY: "hosted-source-key",
      // not part of the selection set — must be left untouched
      NVIDIA_API_KEY: "nvapi-keep-me",
    };

    const restore = isolateAmbientRecreateEnv(env);

    for (const name of AMBIENT_RECREATE_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.NVIDIA_INFERENCE_API_KEY).toBe("hosted-source-key");
    expect(env.NVIDIA_API_KEY).toBe("nvapi-keep-me");

    restore();

    expect(env.NEMOCLAW_AGENT).toBe("langchain-deepagents-code");
    expect(env.NEMOCLAW_PROVIDER_KEY).toBe("sk-bogus");
    expect(env.NEMOCLAW_MODEL).toBe("some-model");
    expect(env.NEMOCLAW_COMPAT_MODEL).toBe("some-compat-model");
    expect(env.NEMOCLAW_PREFERRED_API).toBe("openai-responses");
    expect(env.NEMOCLAW_REASONING).toBe("false");
    expect(env.NEMOCLAW_VLLM_MODEL).toBe("ambient-vllm-model");
    expect(env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON).toBe('{"ambient":true}');
    expect(env.NEMOCLAW_FROM_DOCKERFILE).toBe("/tmp/unrelated.Dockerfile");
    expect(env.NEMOCLAW_WEB_SEARCH_PROVIDER).toBe("tavily");
    expect(env.NEMOCLAW_POLICY_TIER).toBe("permissive");
    expect(env.NEMOCLAW_POLICY_MODE).toBe("customize");
    expect(env.NEMOCLAW_POLICY_PRESETS).toBe("ambient-preset");
    expect(env.NEMOCLAW_SANDBOX_GPU).toBe("0");
    expect(env.NEMOCLAW_SANDBOX_GPU_DEVICE).toBe("9");
    expect(env.NVIDIA_INFERENCE_API_KEY).toBe("hosted-source-key");
    expect(env.NVIDIA_API_KEY).toBe("nvapi-keep-me");
    // A var that was never set stays unset after restore.
    expect("NEMOCLAW_PROVIDER" in env).toBe(false);
  });

  it("is idempotent — a second restore call is a no-op", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_AGENT: "hermes" };
    const restore = isolateAmbientRecreateEnv(env);
    restore();
    env.NEMOCLAW_AGENT = "changed-after-restore";
    restore();
    expect(env.NEMOCLAW_AGENT).toBe("changed-after-restore");
  });
});
