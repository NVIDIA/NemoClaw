// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  env,
  kimiOnboardEnv,
  requirePublicNvidiaApiKey,
  resolveKimiInferenceMode,
} from "../live/kimi-inference-compat-helpers.ts";

describe("Kimi inference compatibility mode selection", () => {
  it("defaults to hermetic mock mode for local validation", () => {
    const cfg = env({}, { mode: "mock" });
    expect(cfg.NEMOCLAW_E2E_INFERENCE_MODE).toBe("mock");
    expect(cfg.NEMOCLAW_PROVIDER).toBe("custom");
    expect(cfg.COMPATIBLE_API_KEY).toBe("test-kimi-key");
    expect(cfg.NVIDIA_API_KEY).toBeUndefined();
  });

  it("keeps public NVIDIA probe envs secret-free by default", () => {
    const cfg = env({}, { mode: "public-nvidia", apiKey: "nvapi-public-test-key" });
    expect(cfg.NEMOCLAW_E2E_INFERENCE_MODE).toBe("public-nvidia");
    expect(cfg.NEMOCLAW_PROVIDER).toBe("cloud");
    expect(cfg.NVIDIA_API_KEY).toBeUndefined();
    expect(cfg.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(cfg.COMPATIBLE_API_KEY).toBeUndefined();
  });

  it("limits the public NVIDIA source secret to onboard and agent envs", () => {
    const cfg = env(
      {},
      {
        mode: "public-nvidia",
        apiKey: "nvapi-public-test-key",
        includeSecret: true,
      },
    );
    expect(cfg.NVIDIA_API_KEY).toBe("nvapi-public-test-key");
    expect(cfg.NVIDIA_INFERENCE_API_KEY).toBe("nvapi-public-test-key");
    expect(kimiOnboardEnv(undefined, "public-nvidia", "nvapi-public-test-key").NVIDIA_API_KEY).toBe(
      "nvapi-public-test-key",
    );
  });

  it("rejects non-public NVIDIA keys for public Kimi validation", () => {
    expect(() => requirePublicNvidiaApiKey("sk-compatible-key")).toThrow(/nvapi-\* key/);
    expect(requirePublicNvidiaApiKey("nvapi-public-test-key")).toBe("nvapi-public-test-key");
  });

  it("maps legacy and explicit env selectors to the expected mode", () => {
    expect(resolveKimiInferenceMode({ NEMOCLAW_E2E_INFERENCE_MODE: "public-nvidia" })).toBe(
      "public-nvidia",
    );
    expect(resolveKimiInferenceMode({ NEMOCLAW_KIMI_USE_MOCK: "0" })).toBe("public-nvidia");
    expect(resolveKimiInferenceMode({ NEMOCLAW_E2E_INFERENCE_MODE: "mock" })).toBe("mock");
  });
});
