// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_LIB = path.join(REPO_ROOT, "test/e2e/runtime/lib");
const VALIDATION_SUITES = path.join(REPO_ROOT, "test/e2e/validation_suites");
const ASSERT = path.join(VALIDATION_SUITES, "assert");
const FIXTURES = path.join(REPO_ROOT, "test/e2e/nemoclaw_scenarios/fixtures");
const INSTALL_DIR = path.join(REPO_ROOT, "test/e2e/nemoclaw_scenarios/install");
const RUN_SCENARIO = path.join(REPO_ROOT, "test/e2e/runtime/run-scenario.sh");

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 1 helpers (logging, sandbox-exec, fixtures, assertions, install
// splits) — extends the pre-existing e2e shell helper coverage.
// ──────────────────────────────────────────────────────────────────────────

describe("E2E shell helpers", () => {
  it("env_helper_should_set_standard_noninteractive_env", () => {
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/env.sh"
      e2e_env_apply_noninteractive
      echo "NEMOCLAW_NON_INTERACTIVE=\${NEMOCLAW_NON_INTERACTIVE:-}"
      echo "DEBIAN_FRONTEND=\${DEBIAN_FRONTEND:-}"
      echo "CI=\${CI:-}"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(r.stdout).toContain("DEBIAN_FRONTEND=noninteractive");
  });

  it("artifact_helper_should_collect_known_logs_without_failing_when_missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-art-"));
    const srcDir = path.join(tmp, "src");
    const dstDir = path.join(tmp, "out");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "present.log"), "hello\n");
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/artifacts.sh"
      e2e_artifact_collect_file "${srcDir}/present.log" "${dstDir}/present.log"
      e2e_artifact_collect_file "${srcDir}/missing.log" "${dstDir}/missing.log" || true
      ls "${dstDir}"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dstDir, "present.log"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "missing.log"))).toBe(false);
    expect(r.stderr + r.stdout).toMatch(/missing\.log|not found|skipping/i);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("gateway_helper_should_report_unhealthy_gateway_clearly", () => {
    // Pick a port very unlikely to be bound.
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/gateway.sh"
      e2e_gateway_assert_healthy "http://127.0.0.1:65531"
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/65531|gateway|unhealthy/i);
  });

  it("sandbox_helper_should_fail_for_missing_sandbox_name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sb-"));
    try {
      // Initialise a context file without E2E_SANDBOX_NAME.
      const r = runBash(
        `
        set -euo pipefail
        . "${RUNTIME_LIB}/context.sh"
        . "${ASSERT}/sandbox-alive.sh"
        e2e_context_init
        e2e_context_set E2E_SCENARIO test
        e2e_sandbox_assert_running
      `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E2E_SANDBOX_NAME/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scenario_dry_run_should_trace_helper_sequence_in_order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-trace-"));
    try {
      const trace = path.join(tmp, "trace.log");
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--dry-run"],
        {
          env: {
            ...process.env,
            E2E_CONTEXT_DIR: tmp,
            E2E_TRACE_FILE: trace,
          },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(trace), "trace log missing").toBe(true);
      const contents = fs.readFileSync(trace, "utf8");
      const order = ["env:noninteractive", "install:", "onboard:", "gateway:check", "sandbox:check"];
      let pos = 0;
      for (const marker of order) {
        const idx = contents.indexOf(marker, pos);
        expect(idx, `trace missing marker in order: ${marker}\nfull:\n${contents}`).toBeGreaterThanOrEqual(0);
        pos = idx + marker.length;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.A — Logging helpers (lib/logging.sh)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1.A logging helpers", () => {
  it("logging_should_emit_stable_pass_marker_when_e2e_pass_called", () => {
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/logging.sh"
      e2e_pass "assertion X"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS:.*assertion X/m);
  });

  it("logging_should_emit_stable_fail_marker_and_nonzero_exit_when_e2e_fail_called", () => {
    const r = runBash(`
      . "${RUNTIME_LIB}/logging.sh"
      ( e2e_fail "assertion Y" )
    `);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/FAIL:.*assertion Y/);
  });

  it("logging_should_include_phase_prefix_when_e2e_section_called", () => {
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/logging.sh"
      e2e_section "Phase 2: onboarding"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^=== Phase 2:.*onboarding/m);
  });

  it("logging_should_autosource_logging_when_env_sh_sourced", () => {
    const r = runBash(`
      set -euo pipefail
      . "${RUNTIME_LIB}/env.sh"
      # e2e_pass must be defined after sourcing env.sh alone.
      e2e_pass "from env.sh"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS:.*from env.sh/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.B — Sandbox exec helper (lib/sandbox-exec.sh)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1.B sandbox-exec helper", () => {
  it("sandbox_exec_should_propagate_exit_code_when_command_fails", () => {
    // Use a fake nemoclaw on PATH that exits 1.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-fail-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "nemoclaw"),
        "#!/usr/bin/env bash\nexit 1\n",
        { mode: 0o755 },
      );
      const r = runBash(
        `
        . "${VALIDATION_SUITES}/sandbox-exec.sh"
        e2e_sandbox_exec sb1 -- false
        echo "rc=$?"
      `,
        { PATH: `${bin}:${process.env.PATH}` },
      );
      expect(r.stdout).toMatch(/rc=1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sandbox_exec_should_dry_run_short_circuit_when_e2e_dry_run_set", () => {
    // Use a PATH that has bash itself but no nemoclaw — dry-run must
    // short-circuit before the CLI lookup.
    const r = runBash(
      `
        set -euo pipefail
        . "${VALIDATION_SUITES}/sandbox-exec.sh"
        e2e_sandbox_exec sb1 -- rm -rf /
      `,
      { E2E_DRY_RUN: "1", PATH: "/usr/bin:/bin" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/dry[- ]run/i);
  });

  it("sandbox_exec_stdin_should_quote_args_safely_when_piped", () => {
    // Verify that $TOKEN is NOT expanded on the host side before being
    // delivered to the sandbox. We stub nemoclaw to echo back stdin.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-stdin-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      // Fake nemoclaw: when called as `nemoclaw shell sb1 -- cat` read
      // stdin and print it verbatim so the test can see what the sandbox
      // would have received.
      fs.writeFileSync(
        path.join(bin, "nemoclaw"),
        '#!/usr/bin/env bash\ncat\n',
        { mode: 0o755 },
      );
      const r = runBash(
        `
          set -euo pipefail
          . "${VALIDATION_SUITES}/sandbox-exec.sh"
          printf 'hello $TOKEN' | e2e_sandbox_exec_stdin sb1 -- cat
        `,
        { PATH: `${bin}:${process.env.PATH}`, TOKEN: "SHOULD_NOT_EXPAND" },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("hello $TOKEN");
      expect(r.stdout).not.toContain("SHOULD_NOT_EXPAND");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.C — Fixtures (lib/fixtures/)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1.C fixtures", () => {
  it("fake_openai_should_start_and_stop_cleanly_and_serve_chat_completions", () => {
    const r = runBash(`
      set -euo pipefail
      . "${FIXTURES}/fake-openai.sh"
      fake_openai_start
      : "\${FAKE_OPENAI_PORT:?not exported}"
      URL="http://127.0.0.1:\${FAKE_OPENAI_PORT}/v1/chat/completions"
      body='{"model":"x","messages":[{"role":"user","content":"hi"}]}'
      out=$(curl -fsS -H 'Content-Type: application/json' -d "$body" "$URL")
      echo "$out"
      fake_openai_stop
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/choices/);
    expect(r.stdout).toMatch(/content/);
  });

  it("older_base_image_should_emit_dockerfile_pointing_at_tagged_base", () => {
    const r = runBash(`
      set -euo pipefail
      . "${FIXTURES}/older-base-image.sh"
      df="$(older_base_image_prepare v0.0.1-test)"
      echo "DF=$df"
      head -n1 "$df"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^FROM .*:v0\.0\.1-test/m);
  });

  it("fake_messaging_fixtures_should_bind_a_port_and_accept_stub_requests", () => {
    for (const provider of ["telegram", "discord", "slack"]) {
      const r = runBash(`
        set -euo pipefail
        . "${FIXTURES}/fake-${provider}.sh"
        fake_${provider}_start
        : "\${FAKE_${provider.toUpperCase()}_PORT:?port not exported}"
        URL="http://127.0.0.1:\${FAKE_${provider.toUpperCase()}_PORT}/ping"
        code=$(curl -fsS -o /dev/null -w '%{http_code}' "$URL" || echo failed)
        echo "code=$code"
        fake_${provider}_stop
      `);
      expect(r.status, `${provider}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toMatch(/code=200/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.D — Assertion helpers (lib/assert/)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1.D assertion helpers", () => {
  it("inference_works_should_pass_when_round_trip_returns_ok", () => {
    const r = runBash(`
      set -euo pipefail
      . "${FIXTURES}/fake-openai.sh"
      . "${ASSERT}/inference-works.sh"
      fake_openai_start
      URL="http://127.0.0.1:\${FAKE_OPENAI_PORT}"
      e2e_assert_inference_works "$URL"
      rc=$?
      fake_openai_stop
      exit $rc
    `);
    expect(r.status, r.stderr).toBe(0);
  });

  it("no_credentials_leaked_should_fail_when_pattern_leaks_in_bundle", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-creds-"));
    try {
      const bundle = path.join(tmp, "bundle");
      fs.mkdirSync(bundle);
      fs.writeFileSync(path.join(bundle, "leak.txt"), "token=sk-abc123DEADBEEFCAFE0000111122223333");
      const r = runBash(`
        . "${ASSERT}/no-credentials-leaked.sh"
        e2e_assert_no_credentials_leaked "${bundle}"
      `);
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/FAIL:/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("policy_preset_applied_should_pass_when_active_presets_match_declared_set", () => {
    // Stub `nemoclaw policies list` to emit a known set.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pol-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "nemoclaw"),
        '#!/usr/bin/env bash\nif [[ "$1" == "policies" && "$2" == "list" ]]; then\n  printf "slack\\ndiscord\\n"\nfi\n',
        { mode: 0o755 },
      );
      const r = runBash(
        `
          set -euo pipefail
          . "${ASSERT}/policy-preset-applied.sh"
          e2e_assert_policy_preset_applied slack discord
        `,
        { PATH: `${bin}:${process.env.PATH}` },
      );
      expect(r.status, r.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("messaging_bridge_reachable_should_pass_when_provider_endpoint_alive", () => {
    const r = runBash(`
      set -euo pipefail
      . "${FIXTURES}/fake-telegram.sh"
      . "${ASSERT}/messaging-bridge-reachable.sh"
      fake_telegram_start
      export MESSAGING_BRIDGE_URL="http://127.0.0.1:\${FAKE_TELEGRAM_PORT}"
      e2e_assert_messaging_bridge_reachable telegram
      rc=$?
      fake_telegram_stop
      exit $rc
    `);
    expect(r.status, r.stderr).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.E — Install-method dispatcher splits
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 1.E install dispatcher splits", () => {
  function dispatchDryRun(profile: string): SpawnSyncReturns<string> {
    return runBash(
      `
        set -euo pipefail
        . "${INSTALL_DIR}/dispatch.sh"
        e2e_install "${profile}"
      `,
      { E2E_DRY_RUN: "1" },
    );
  }

  it("install_should_dispatch_to_install_repo_helper_for_repo_current_profile", () => {
    const r = dispatchDryRun("repo-current");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/install-repo/);
    expect(r.stdout + r.stderr).not.toMatch(/install-curl|install-ollama|install-launchable/);
  });

  it("install_should_dispatch_to_install_curl_helper_for_public_installer_profile", () => {
    const r = dispatchDryRun("public-installer");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/install-curl/);
    expect(r.stdout + r.stderr).not.toMatch(/install-repo|install-ollama|install-launchable/);
  });

  it("install_should_dispatch_to_install_ollama_helper_for_ollama_profile", () => {
    const r = dispatchDryRun("ollama");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/install-ollama/);
    expect(r.stdout + r.stderr).not.toMatch(/install-repo|install-curl|install-launchable/);
  });

  it("install_should_dispatch_to_install_launchable_helper_for_launchable_profile", () => {
    const r = dispatchDryRun("launchable");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/install-launchable/);
    expect(r.stdout + r.stderr).not.toMatch(/install-repo|install-curl|install-ollama/);
  });
});
