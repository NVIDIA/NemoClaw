// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hydrateCredentialEnv,
  snapshotCredentialEnv,
  snapshotKnownCredentialEnv,
} from "./credential-env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("snapshotKnownCredentialEnv", () => {
  it("copies allowlisted credentials without exposing unrelated environment secrets", () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "nvapi-worker-test");
    vi.stubEnv("UNRELATED_SECRET", "must-not-cross-worker-boundary");

    const snapshot = snapshotKnownCredentialEnv();

    expect(snapshot.NVIDIA_INFERENCE_API_KEY).toBe("nvapi-worker-test");
    expect(snapshot).not.toHaveProperty("UNRELATED_SECRET");
  });
});

describe("snapshotCredentialEnv", () => {
  it("copies only selected known credentials", () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "nvapi-worker-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-unrelated-test");

    expect(snapshotCredentialEnv(["NVIDIA_INFERENCE_API_KEY", "UNRELATED_SECRET"])).toEqual({
      NVIDIA_INFERENCE_API_KEY: "nvapi-worker-test",
    });
  });
});

describe("hydrateCredentialEnv", () => {
  it("returns null for empty env names", () => {
    expect(hydrateCredentialEnv(null)).toBeNull();
    expect(hydrateCredentialEnv(undefined)).toBeNull();
    expect(hydrateCredentialEnv("")).toBeNull();
  });

  it("delegates credential resolution and preserves process.env hydration side effects", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined);

    const hydrated = hydrateCredentialEnv("TELEGRAM_BOT_TOKEN", (envName) => {
      if (envName !== "TELEGRAM_BOT_TOKEN") return null;
      process.env[envName] = "stored-telegram-token";
      return process.env[envName] || null;
    });
    const missing = hydrateCredentialEnv("NONEXISTENT_KEY", () => null);

    expect(hydrated).toBe("stored-telegram-token");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("stored-telegram-token");
    expect(missing).toBeNull();
  });
});
