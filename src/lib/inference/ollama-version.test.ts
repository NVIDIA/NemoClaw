// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getInstalledOllamaVersion,
  getRunningOllamaDaemonVersion,
  hasOllamaSystemdUnit,
  isOllamaVersionAtLeast,
  MIN_OLLAMA_VERSION,
} from "./ollama-version";

const OLLAMA_SYSTEMD_UNIT_PROBE = [
  "sh",
  "-c",
  "command -v systemctl >/dev/null && [ -d /run/systemd/system ] && systemctl list-unit-files ollama.service --no-legend 2>/dev/null | head -n1",
] as const;

describe("Ollama version detection", () => {
  it("skips systemd unit detection outside Linux", () => {
    const capture = vi.fn(() => "ollama.service enabled");

    expect({ detected: hasOllamaSystemdUnit(capture, "darwin"), calls: capture.mock.calls }).toEqual(
      { detected: false, calls: [] },
    );
  });

  it.each([
    { output: "", detected: false },
    { output: "ollama.service enabled", detected: true },
  ])("detects a Linux systemd unit from %j", ({ output, detected }) => {
    const capture = vi.fn(() => output);

    expect({
      detected: hasOllamaSystemdUnit(capture, "linux"),
      calls: capture.mock.calls,
    }).toEqual({
      detected,
      calls: [[OLLAMA_SYSTEMD_UNIT_PROBE, { ignoreError: true, timeout: 5_000 }]],
    });
  });

  it("parses 'ollama version is X.Y.Z' output", () => {
    const capture = () => "ollama version is 0.6.2";
    expect(getInstalledOllamaVersion(capture)).toBe("0.6.2");
  });

  it("prefers the client version line over the daemon version the CLI reports (#9276)", () => {
    const capture = () => "ollama version is 0.23.4\nWarning: client version is 0.32.9";
    expect(getInstalledOllamaVersion(capture)).toBe("0.32.9");
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

  it("treats Ollama 0.32.8 as below the structured-tool-call floor (#8979)", () => {
    expect(isOllamaVersionAtLeast("0.32.8", MIN_OLLAMA_VERSION)).toBe(false);
  });

  it("treats Ollama 0.32.9 as meeting the structured-tool-call floor (#8979)", () => {
    expect(isOllamaVersionAtLeast("0.32.9", MIN_OLLAMA_VERSION)).toBe(true);
  });

  it("treats newer Ollama versions as meeting the floor", () => {
    expect(isOllamaVersionAtLeast("0.32.11", MIN_OLLAMA_VERSION)).toBe(true);
  });

  it("treats 1.0.0 as above the floor", () => {
    expect(isOllamaVersionAtLeast("1.0.0", MIN_OLLAMA_VERSION)).toBe(true);
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
