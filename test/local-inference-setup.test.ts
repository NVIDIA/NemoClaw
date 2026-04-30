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

  it("vLLM binds to loopback, not all interfaces", () => {
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(/vllm\.entrypoints\.openai\.api_server[\s\S]*--host 127\.0\.0\.1/);
    expect(content).not.toMatch(/vllm\.entrypoints\.openai\.api_server[\s\S]*--host 0\.0\.0\.0/);
  });

  it("readiness loop validates the served model id", () => {
    // The readiness poll must not declare success on any 200 from /v1/models;
    // it has to confirm the response advertises the requested model in the
    // JSON-quoted id field, so a stale listener serving a superstring of
    // $model can't masquerade as the new process.
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(
      /Waiting for vLLM[\s\S]*ready_models=[\s\S]*grep -Fq "\\"id\\":\\"\$model\\""[\s\S]*vLLM ready/,
    );
  });

  it("main() aborts the install when NEMOCLAW_PROVIDER=vllm and setup fails", () => {
    // Silently warning-and-continuing leaves onboarding pointed at a broken
    // localhost:8000 — the exact failure mode the vLLM path is meant to fix.
    const content = fs.readFileSync(INSTALL_SH, "utf-8");
    expect(content).toMatch(
      /NEMOCLAW_PROVIDER:-.*==\s*"vllm"[\s\S]*install_or_start_vllm \|\| error/,
    );
  });

  it("install_or_start_vllm fails when NEMOCLAW_PROVIDER=vllm and no GPU is detected", () => {
    // detect_gpu is stubbed to fail. With NEMOCLAW_PROVIDER=vllm, the function
    // must return non-zero so main()'s `|| error` wrapper trips and the
    // installer aborts before onboarding runs against a non-existent vLLM.
    // `set +e` is needed after sourcing because install.sh itself sets
    // `set -euo pipefail`, which would short-circuit the test before $? is read.
    const result = spawnSync(
      "bash",
      [
        "-c",
        `SCRIPT_DIR="$(dirname "${INSTALL_SH}")"; source "${INSTALL_SH}"; set +e; detect_gpu() { return 1; }; NEMOCLAW_PROVIDER=vllm install_or_start_vllm; echo "rc=$?"`,
      ],
      { encoding: "utf-8" },
    );
    expect(result.stdout).toContain("rc=1");
    expect(result.stdout + result.stderr).toContain("no GPU detected");
  });
});
