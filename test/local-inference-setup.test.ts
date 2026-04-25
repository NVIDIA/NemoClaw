// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");
const BLUEPRINT = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");

function sourceAndRun(body: string) {
  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; SCRIPT_DIR="$(dirname "${INSTALL_SH}")"; source "${INSTALL_SH}"; ${body}`,
    ],
    { encoding: "utf-8" },
  );
}

describe("local inference setup (install.sh)", () => {
  it("install_or_start_vllm is a no-op when NEMOCLAW_PROVIDER is not vllm", () => {
    const result = sourceAndRun(
      `NEMOCLAW_PROVIDER=openai install_or_start_vllm; echo "rc=$?"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rc=0");
    expect(result.stdout).not.toContain("Installing vLLM");
    expect(result.stdout).not.toContain("Starting vLLM");
  });

  it("install_or_upgrade_ollama is not invoked when NEMOCLAW_PROVIDER is not ollama", () => {
    // Sanity-check the main() gating by grepping for the conditional wrapping the call.
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(/NEMOCLAW_PROVIDER:-.*==\s*"ollama"[\s\S]*install_or_upgrade_ollama/);
  });

  it("vLLM default model id matches the blueprint", () => {
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    const installMatch = content.match(/VLLM_DEFAULT_MODEL="([^"]+)"/);
    expect(installMatch).not.toBeNull();
    const installModel = installMatch![1];

    const blueprintContent = fs.readFileSync(BLUEPRINT, "utf-8");
    const blueprintMatch = blueprintContent.match(/vllm:[\s\S]*?model:\s*"([^"]+)"/);
    expect(blueprintMatch).not.toBeNull();
    const blueprintModel = blueprintMatch![1];

    expect(installModel).toBe(blueprintModel);
  });

  it("vLLM startup uses --trust-remote-code", () => {
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(/vllm\.entrypoints\.openai\.api_server[\s\S]*--trust-remote-code/);
  });
});
