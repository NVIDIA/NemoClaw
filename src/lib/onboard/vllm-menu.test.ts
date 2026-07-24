// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildVllmMenuEntries, isManagedVllmDefaultPlatform } from "./vllm-menu";

describe("buildVllmMenuEntries", () => {
  it("returns no entries when nothing is running, no profile, and no opt-in", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: null,
      experimental: false,
      hasVllmImage: false,
      log: () => {},
      env: {},
    });
    assert.deepEqual(entries, []);
  });

  it("marks the running entry experimental on generic hosts", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: true,
      vllmProfile: null,
      experimental: false,
      platform: "linux",
      hasVllmImage: false,
      log: () => {},
      env: {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "vllm");
    assert.match(entries[0].label, /Local vLLM \[experimental\]/);
    assert.match(entries[0].label, /running/);
  });

  for (const [platform, hostLabel] of [
    ["spark", "Spark"],
    ["station", "Station"],
  ] as const) {
    it(`does not mark the running entry experimental on DGX ${hostLabel}`, () => {
      const entries = buildVllmMenuEntries({
        vllmRunning: true,
        vllmProfile: null,
        experimental: false,
        platform,
        hasVllmImage: false,
        log: () => {},
        env: {},
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].key, "vllm");
      assert.doesNotMatch(entries[0].label, /experimental/);
      assert.match(entries[0].label, /running/);
    });
  }

  it("returns the install entry when a profile matches and EXPERIMENTAL is set", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: { name: "Linux NVIDIA" },
      experimental: true,
      hasVllmImage: false,
      env: {},
      log: () => {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "install-vllm");
    assert.equal(entries[0].label, "Install vLLM (Linux NVIDIA)");
  });

  it("returns the install entry by default for DGX Spark", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: { name: "DGX Spark" },
      experimental: false,
      platform: "spark",
      hasVllmImage: false,
      env: {},
      log: () => {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "install-vllm");
    assert.equal(entries[0].label, "Install vLLM (DGX Spark)");
  });

  it("returns the start entry by default for DGX Station when the image is already cached", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: { name: "DGX Station" },
      experimental: false,
      platform: "station",
      hasVllmImage: true,
      env: {},
      log: () => {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "install-vllm");
    assert.equal(entries[0].label, "Start vLLM (DGX Station)");
  });

  it("keeps generic Linux managed vLLM behind EXPERIMENTAL", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: { name: "Linux NVIDIA" },
      experimental: false,
      platform: "linux",
      hasVllmImage: false,
      env: {},
      log: () => {},
    });
    assert.deepEqual(entries, []);
  });

  it("uses Start verb when the image is already cached", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: { name: "DGX Spark" },
      experimental: true,
      hasVllmImage: true,
      env: {},
      log: () => {},
    });
    assert.equal(entries[0].label, "Start vLLM (DGX Spark)");
  });

  it("surfaces install-vllm even when no profile matches if NEMOCLAW_PROVIDER=install-vllm is set (#3765)", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: null,
      experimental: true,
      hasVllmImage: false,
      env: { NEMOCLAW_PROVIDER: "install-vllm" },
      log: () => {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "install-vllm");
    assert.match(entries[0].label, /no profile detected/);
  });

  it("does NOT surface install-vllm when no profile matches and the user did not explicitly opt in", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: false,
      vllmProfile: null,
      experimental: true, // EXPERIMENTAL alone is not enough without a profile
      hasVllmImage: false,
      env: {},
      log: () => {},
    });
    assert.deepEqual(entries, []);
  });

  it("logs a note when running vLLM overrides an explicit NEMOCLAW_PROVIDER=install-vllm (#3765)", () => {
    const logs: string[] = [];
    const entries = buildVllmMenuEntries({
      vllmRunning: true,
      vllmProfile: null,
      experimental: true,
      hasVllmImage: false,
      env: { NEMOCLAW_PROVIDER: "install-vllm" },
      log: (m) => logs.push(m),
    });
    assert.equal(entries[0].key, "vllm");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /NEMOCLAW_PROVIDER=install-vllm requested/);
    assert.match(logs[0], /already running on localhost:8000/);
    assert.match(logs[0], /selecting the running instance/);
  });

  it("does not log the override note when the user did not request install-vllm", () => {
    const logs: string[] = [];
    buildVllmMenuEntries({
      vllmRunning: true,
      vllmProfile: null,
      experimental: false,
      hasVllmImage: false,
      env: {},
      log: (m) => logs.push(m),
    });
    assert.deepEqual(logs, []);
  });
});

describe("isManagedVllmDefaultPlatform (#7293)", () => {
  it("is true for the DGX managed-vLLM default platforms", () => {
    assert.equal(isManagedVllmDefaultPlatform("spark"), true);
    assert.equal(isManagedVllmDefaultPlatform("station"), true);
  });

  it("is false for other or missing platforms", () => {
    assert.equal(isManagedVllmDefaultPlatform("linux"), false);
    assert.equal(isManagedVllmDefaultPlatform("jetson"), false);
    assert.equal(isManagedVllmDefaultPlatform(null), false);
    assert.equal(isManagedVllmDefaultPlatform(undefined), false);
  });
});
