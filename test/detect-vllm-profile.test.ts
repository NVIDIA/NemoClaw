// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

import { detectVllmProfile } from "../dist/lib/onboard-vllm.js";

describe("detectVllmProfile", () => {
  it("returns the Spark profile when gpu.platform === 'spark'", () => {
    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("DGX Spark");
    expect(profile!.model).toBe("Qwen/Qwen3.6-27B-FP8");
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
    expect(profile!.model).toContain("Nemotron-3-Nano-4B");
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
