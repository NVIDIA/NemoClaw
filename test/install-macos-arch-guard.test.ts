// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// The public curl|bash installer must reject an unsupported macOS architecture
// before it resolves a ref or clones anything, so an Intel Mac gets an
// actionable message instead of a mid-install failure and wasted downloads.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/7297

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

// Drive the real bootstrap: source install.sh, stub `uname` to report the target
// platform, and replace the download entrypoint with a sentinel so we can prove
// whether the clone path was reached.
function runBootstrap(unameS: string, unameM: string) {
  const script = [
    'source "$INSTALLER_UNDER_TEST"',
    'uname() { case "$1" in -s) printf %s "$UNAME_S" ;; -m) printf %s "$UNAME_M" ;; *) command uname "$@" ;; esac; }',
    'exec_installer_from_ref() { printf "REACHED_INSTALLER\\n"; }',
    "bootstrap_main",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, INSTALLER_UNDER_TEST: INSTALLER, UNAME_S: unameS, UNAME_M: unameM },
  });
  return { result, output: `${result.stdout}${result.stderr}` };
}

describe("installer macOS architecture guard (#7297)", () => {
  it("fast-fails on Intel Mac (x86_64 Darwin) before any clone", () => {
    const { result, output } = runBootstrap("Darwin", "x86_64");

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "Apple Silicon (aarch64) is required on macOS. Intel Mac (x86_64) is not supported.",
    );
    // The download entrypoint must never be reached on the rejected platform.
    expect(output).not.toContain("REACHED_INSTALLER");
  });

  it.each([
    ["Apple Silicon macOS", "Darwin", "arm64"],
    ["Linux x86_64", "Linux", "x86_64"],
    ["Linux aarch64", "Linux", "aarch64"],
  ])("proceeds to the installer on a supported platform: %s", (_label, unameS, unameM) => {
    const { result, output } = runBootstrap(unameS, unameM);

    expect(result.status, output).toBe(0);
    expect(output).toContain("REACHED_INSTALLER");
    expect(output).not.toContain("Apple Silicon (aarch64) is required");
  });
});
