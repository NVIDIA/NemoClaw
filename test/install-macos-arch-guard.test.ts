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
// platform, and replace ref and download entrypoints with sentinels.
function runBootstrap(unameS: string, unameM: string) {
  const script = [
    'source "$INSTALLER_UNDER_TEST"',
    'uname() { case "$1" in -s) printf %s "$UNAME_S" ;; -m) printf %s "$UNAME_M" ;; *) command uname "$@" ;; esac; }',
    'resolve_release_tag() { printf "REACHED_RESOLVE\\n" >&2; printf "test-ref"; }',
    'clone_nemoclaw_ref() { printf "REACHED_CLONE\\n"; }',
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
  it("rejects Intel macOS before ref resolution or clone", () => {
    const { result, output } = runBootstrap("Darwin", "x86_64");

    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "Apple Silicon (aarch64) is required on macOS. Intel Mac (x86_64) is not supported.",
    );
    expect(output).not.toMatch(/REACHED_(RESOLVE|CLONE|INSTALLER)/);
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
