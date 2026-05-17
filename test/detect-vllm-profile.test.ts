// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import {
  buildHfTokenDockerArgs,
  buildHfTokenForwardEnv,
  detectVllmProfile,
} from "../dist/lib/inference/vllm.js";

describe("detectVllmProfile", () => {
  it("returns the Spark profile when gpu.platform === 'spark'", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
    expect(profile!.defaultModel.id).toBe("Qwen/Qwen3.6-27B-FP8");
  });

  it("returns the Spark profile when legacy gpu.spark is true", () => {
    const profile = detectVllmProfile({ spark: true, type: "nvidia" });
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
  });

  it("returns the Station profile when gpu.platform === 'station'", () => {
    const profile = detectVllmProfile({ platform: "station", type: "nvidia" });
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Station");
  });

  it("returns the generic Linux profile for non-Spark/Station NVIDIA hosts", () => {
    const profile = detectVllmProfile({ type: "nvidia" });
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Linux + NVIDIA GPU");
    expect(profile!.defaultModel.id).toContain("Nemotron-3-Nano-4B");
  });

  it("prefers Spark over generic when both flags qualify", () => {
    const profile = detectVllmProfile({ spark: true, type: "nvidia" });
    expect(profile!.name).toBe("DGX Spark");
  });

  it("returns Spark when both legacy spark flag and platform field are set", () => {
    const profile = detectVllmProfile({ platform: "spark", spark: true, type: "nvidia" });
    expect(profile!.name).toBe("DGX Spark");
  });

  it("platform field is authoritative over the legacy spark flag", () => {
    // Conflicting payload: platform says station, legacy spark says true.
    // platform must win.
    const profile = detectVllmProfile({ platform: "station", spark: true, type: "nvidia" });
    expect(profile!.name).toBe("DGX Station");
  });

  it("returns null when gpu is null or undefined", () => {
    expect(detectVllmProfile(null)).toBeNull();
    expect(detectVllmProfile(undefined)).toBeNull();
  });

  it("returns null for non-NVIDIA GPUs", () => {
    expect(detectVllmProfile({ type: "apple" })).toBeNull();
    expect(detectVllmProfile({ type: "amd" })).toBeNull();
    expect(detectVllmProfile({})).toBeNull();
  });

  it("ready/fatal markers are populated and shared between profiles", () => {
    const spark = detectVllmProfile({ spark: true });
    const generic = detectVllmProfile({ type: "nvidia" });
    expect(spark!.readyMarker).toBeInstanceOf(RegExp);
    expect(spark!.fatalMarkers.length).toBeGreaterThan(0);
    // Generic profile reuses Spark's marker tables.
    expect(generic!.readyMarker).toBe(spark!.readyMarker);
    expect(generic!.fatalMarkers).toBe(spark!.fatalMarkers);
  });
});

describe("buildHfTokenDockerArgs", () => {
  it("returns no extra env when neither HF token is set", () => {
    expect(buildHfTokenDockerArgs({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("emits the bare `-e KEY` form so the token never enters the docker run argv", () => {
    // Docker reads the value from its inherited environment when -e is given
    // without =value; this keeps the secret out of /proc/<pid>/cmdline for
    // the multi-minute hf-download and long-lived vllm-serve containers.
    expect(
      buildHfTokenDockerArgs({ HF_TOKEN: "hf_abc123" } as NodeJS.ProcessEnv),
    ).toEqual(["-e", "HF_TOKEN"]);
  });

  it("falls back to HUGGING_FACE_HUB_TOKEN when HF_TOKEN is empty", () => {
    expect(
      buildHfTokenDockerArgs({
        HF_TOKEN: "",
        HUGGING_FACE_HUB_TOKEN: "hf_xyz",
      } as NodeJS.ProcessEnv),
    ).toEqual(["-e", "HUGGING_FACE_HUB_TOKEN"]);
  });

  it("prefers HF_TOKEN when both env vars are set", () => {
    expect(
      buildHfTokenDockerArgs({
        HF_TOKEN: "hf_primary",
        HUGGING_FACE_HUB_TOKEN: "hf_secondary",
      } as NodeJS.ProcessEnv),
    ).toEqual(["-e", "HF_TOKEN"]);
  });

  it("ignores tokens that are whitespace-only", () => {
    expect(
      buildHfTokenDockerArgs({ HF_TOKEN: "   " } as NodeJS.ProcessEnv),
    ).toEqual([]);
  });
});

describe("buildHfTokenForwardEnv", () => {
  it("returns an empty map when no HF token is set", () => {
    expect(buildHfTokenForwardEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it("re-exports HF_TOKEN so runner-allowlisted subprocesses can see it", () => {
    // The runner's allowlist (subprocess-env.ts) drops HF_TOKEN by default;
    // this map is what callers pass via `env:` so docker can pick the
    // value up when the argv only carries `-e HF_TOKEN` (key-only).
    expect(
      buildHfTokenForwardEnv({ HF_TOKEN: "hf_abc" } as NodeJS.ProcessEnv),
    ).toEqual({ HF_TOKEN: "hf_abc" });
  });

  it("falls back to HUGGING_FACE_HUB_TOKEN when HF_TOKEN is missing", () => {
    expect(
      buildHfTokenForwardEnv({
        HUGGING_FACE_HUB_TOKEN: "hf_xyz",
      } as NodeJS.ProcessEnv),
    ).toEqual({ HUGGING_FACE_HUB_TOKEN: "hf_xyz" });
  });

  it("only forwards one key when both are set, matching the argv builder", () => {
    expect(
      buildHfTokenForwardEnv({
        HF_TOKEN: "hf_primary",
        HUGGING_FACE_HUB_TOKEN: "hf_secondary",
      } as NodeJS.ProcessEnv),
    ).toEqual({ HF_TOKEN: "hf_primary" });
  });
});
