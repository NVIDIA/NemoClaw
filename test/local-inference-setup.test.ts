// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts", "install.sh");

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

  it("main skips Ollama setup when NEMOCLAW_PROVIDER is not ollama", () => {
    const result = sourceAndRun(`
print_banner() { :; }
bash() { :; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
install_or_upgrade_ollama() { echo OLLAMA_CALLED; return 0; }
install_or_start_vllm() { :; }
fix_npm_permissions() { :; }
install_nemoclaw() { :; }
verify_nemoclaw() { NEMOCLAW_READY_NOW=true; }
run_onboarding() { :; }
print_summary() { :; }
post_install_message() { :; }
command_exists() { return 1; }
NEMOCLAW_PROVIDER=openai main --non-interactive --yes-i-accept-third-party-software
echo done
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("done");
    expect(result.stdout).not.toContain("OLLAMA_CALLED");
  });

  it("vLLM startup uses trusted loopback serving and waits for exact model readiness", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-start-"));
    const log = path.join(tmp, "vllm.log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `SCRIPT_DIR="$(dirname "${INSTALL_SH}")"; source "${INSTALL_SH}"; \
set +e; \
detect_gpu() { return 0; }; \
python3() { if [ "\${1:-}" = "-c" ]; then return 0; fi; echo "PYTHON $*" >> ${JSON.stringify(log)}; return 0; }; \
nohup() { "$@"; }; \
kill() { return 0; }; \
curl_state=${JSON.stringify(path.join(tmp, "curl.seen"))}; \
curl() { if [ ! -f "$curl_state" ]; then touch "$curl_state"; echo '{"data":[{"id":"stale-model"}]}'; else echo '{"data":[{"id":"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8"}]}'; fi; }; \
export -f detect_gpu python3 nohup kill curl; \
NEMOCLAW_PROVIDER=vllm install_or_start_vllm; echo "rc=$?"`,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );
    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("vLLM ready");
      expect(result.stdout).toContain("rc=0");
      const launched = fs.readFileSync(log, "utf-8");
      expect(launched).toContain("-m vllm.entrypoints.openai.api_server");
      expect(launched).toContain("--host 127.0.0.1");
      expect(launched).not.toContain("--host 0.0.0.0");
      expect(launched).toContain("--trust-remote-code");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("main() aborts the install when NEMOCLAW_PROVIDER=vllm and setup fails", () => {
    const result = sourceAndRun(`
print_banner() { :; }
bash() { :; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
install_or_upgrade_ollama() { :; }
install_or_start_vllm() { echo VLLM_FAIL; return 1; }
fix_npm_permissions() { :; }
install_nemoclaw() { :; }
verify_nemoclaw() { NEMOCLAW_READY_NOW=true; }
run_onboarding() { :; }
print_summary() { :; }
post_install_message() { :; }
command_exists() { return 1; }
error() { echo "ERROR: $*"; exit 77; }
NEMOCLAW_PROVIDER=vllm main --non-interactive --yes-i-accept-third-party-software
`);
    expect(result.status).toBe(77);
    expect(result.stdout).toContain("VLLM_FAIL");
    expect(result.stdout).toContain("vLLM setup failed");
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
