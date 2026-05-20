// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildVllmMenuEntries } from "../../../dist/lib/onboard/vllm-menu";

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

  it("returns the running entry when vLLM is reachable on localhost", () => {
    const entries = buildVllmMenuEntries({
      vllmRunning: true,
      vllmProfile: null,
      experimental: false,
      hasVllmImage: false,
      log: () => {},
      env: {},
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, "vllm");
    assert.match(entries[0].label, /Local vLLM \[experimental\]/);
    assert.match(entries[0].label, /running/);
  });

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
