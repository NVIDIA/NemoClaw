// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getInstalledOllamaVersion,
  getRunningOllamaDaemonVersion,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
} from "../../../dist/lib/inference/ollama-version";

describe("Ollama version detection", () => {
  it("parses 'ollama version is X.Y.Z' output", () => {
    const capture = () => "ollama version is 0.6.2";
    expect(getInstalledOllamaVersion(capture)).toBe("0.6.2");
  });

  it("returns null when ollama --version produces no output", () => {
    const capture = () => "";
    expect(getInstalledOllamaVersion(capture)).toBeNull();
  });

  it("returns null when ollama --version output has no version", () => {
    const capture = () => "ollama: command not found";
    expect(getInstalledOllamaVersion(capture)).toBeNull();
  });

  it("treats null/missing versions as below the minimum", () => {
    expect(isOllamaVersionAtLeast(null, MIN_OLLAMA_VERSION)).toBe(false);
  });

  it("treats 0.6.2 as below the 0.7.0 floor", () => {
    expect(isOllamaVersionAtLeast("0.6.2", "0.7.0")).toBe(false);
  });

  it("treats 0.7.0 as meeting the 0.7.0 floor", () => {
    expect(isOllamaVersionAtLeast("0.7.0", "0.7.0")).toBe(true);
  });

  it("treats 0.24.0 as above the 0.7.0 floor", () => {
    expect(isOllamaVersionAtLeast("0.24.0", "0.7.0")).toBe(true);
  });

  it("treats 1.0.0 as above the 0.7.0 floor", () => {
    expect(isOllamaVersionAtLeast("1.0.0", "0.7.0")).toBe(true);
  });

  it("returns false for unparseable version components", () => {
    expect(isOllamaVersionAtLeast("not-a-version", "0.7.0")).toBe(false);
  });

  it("reads the running daemon version from /api/version", () => {
    const capture = () => '{"version":"0.24.0"}';
    expect(getRunningOllamaDaemonVersion(capture)).toBe("0.24.0");
  });

  it("returns null when the daemon endpoint is unreachable", () => {
    const capture = () => "";
    expect(getRunningOllamaDaemonVersion(capture)).toBeNull();
  });

  it("returns null when the daemon payload is not JSON", () => {
    const capture = () => "ollama is running";
    expect(getRunningOllamaDaemonVersion(capture)).toBeNull();
  });

  it("returns null when the daemon payload omits a version field", () => {
    const capture = () => '{"status":"ok"}';
    expect(getRunningOllamaDaemonVersion(capture)).toBeNull();
  });
});
