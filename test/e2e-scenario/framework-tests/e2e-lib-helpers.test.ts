// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUNTIME_LIB = path.join(REPO_ROOT, "test/e2e-scenario/runtime/lib");
const VALIDATION_SUITES = path.join(REPO_ROOT, "test/e2e-scenario/validation_suites");
const VALIDATION_LIB = path.join(VALIDATION_SUITES, "lib");
const ASSERT = path.join(VALIDATION_SUITES, "assert");
const REBUILD_UPGRADE_LIB = path.join(VALIDATION_SUITES, "lib/rebuild_upgrade.sh");
const FIXTURES = path.join(REPO_ROOT, "test/e2e-scenario/nemoclaw_scenarios/fixtures");
const INSTALL_DIR = path.join(REPO_ROOT, "test/e2e-scenario/nemoclaw_scenarios/install");
const ONBOARD_DIR = path.join(REPO_ROOT, "test/e2e-scenario/nemoclaw_scenarios/onboard");

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
  it("test_should_source_inference_routing_helpers_under_strict_shell_mode", () => {
    const r = runBash(`
      set -euo pipefail
      . "${VALIDATION_SUITES}/lib/inference_routing.sh"
      declare -F e2e_inference_routing_assert_chat_completion
    `);
    expect(r.status, r.stderr).toBe(0);
  });

  it("test_should_fail_clearly_when_required_context_is_missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-inf-missing-"));
    try {
      const r = runBash(
        `
        set -euo pipefail
        . "${RUNTIME_LIB}/context.sh"
        . "${VALIDATION_SUITES}/lib/inference_routing.sh"
        e2e_context_init
        e2e_inference_routing_assert_chat_completion "post-onboard.inference-routing.inference-local-chat-completion"
      `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E2E_SANDBOX_NAME|E2E_CONTEXT_DIR|context/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no_docker_onboarding_worker_should_preserve_seeded_context_and_redact_log", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-no-docker-context-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" = "onboard" ]]; then
  expected='onboard --non-interactive --yes --yes-i-accept-third-party-software'
  if [[ "$*" != "\${expected}" ]]; then
    echo "unexpected nemoclaw args: $*" >&2
    exit 2
  fi
  if [[ "\${NEMOCLAW_AGENT:-}" != "openclaw" || "\${NEMOCLAW_PROVIDER:-}" != "cloud" || "\${NEMOCLAW_SANDBOX_NAME:-}" != "e2e-preserved" ]]; then
    echo "unexpected nemoclaw env: agent=\${NEMOCLAW_AGENT:-unset} provider=\${NEMOCLAW_PROVIDER:-unset} sandbox=\${NEMOCLAW_SANDBOX_NAME:-unset}" >&2
    exit 2
  fi
  echo "NVIDIA_API_KEY=\${NVIDIA_API_KEY:-unset}" >&2
  echo "Docker is required before onboarding" >&2
  exit 42
fi
echo "unexpected nemoclaw invocation: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-no-docker-preflight-negative\nE2E_SANDBOX_NAME=e2e-preserved\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-no-docker "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-no-docker",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          NVIDIA_API_KEY: "secret-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const contextBody = fs.readFileSync(path.join(tmp, "context.env"), "utf8");
      expect(contextBody).toMatch(/^E2E_SANDBOX_NAME=e2e-preserved$/m);
      const logBody = fs.readFileSync(path.join(tmp, "negative-preflight.log"), "utf8");
      expect(logBody).toContain("Docker is required before onboarding");
      expect(logBody).toContain("[REDACTED]");
      expect(logBody).not.toContain("secret-token");
      const tempEntries = fs.readdirSync(tmp, { recursive: true }).map(String).join("\n");
      expect(tempEntries).not.toContain("negative-preflight.raw.log");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no_docker_onboarding_worker_should_fail_on_unrelated_onboarding_errors", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-no-docker-unrelated-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" = "onboard" ]]; then
  expected='onboard --non-interactive --yes --yes-i-accept-third-party-software'
  if [[ "$*" != "\${expected}" ]]; then
    echo "unexpected nemoclaw args: $*" >&2
    exit 2
  fi
  if [[ "\${NEMOCLAW_AGENT:-}" != "openclaw" || "\${NEMOCLAW_PROVIDER:-}" != "cloud" || "\${NEMOCLAW_SANDBOX_NAME:-}" != "e2e-preserved" ]]; then
    echo "unexpected nemoclaw env: agent=\${NEMOCLAW_AGENT:-unset} provider=\${NEMOCLAW_PROVIDER:-unset} sandbox=\${NEMOCLAW_SANDBOX_NAME:-unset}" >&2
    exit 2
  fi
  echo "provider rejected NVIDIA_API_KEY=\${NVIDIA_API_KEY:-unset}" >&2
  exit 42
fi
echo "unexpected nemoclaw invocation: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-no-docker-preflight-negative\nE2E_SANDBOX_NAME=e2e-preserved\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-no-docker "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-no-docker",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          NVIDIA_API_KEY: "secret-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(r.status).toBe(42);
      expect(`${r.stdout}\n${r.stderr}`).toContain("failed without Docker-missing preflight signature");
      const logBody = fs.readFileSync(path.join(tmp, "negative-preflight.log"), "utf8");
      expect(logBody).toContain("provider rejected");
      expect(logBody).toContain("[REDACTED]");
      expect(logBody).not.toContain("secret-token");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no_docker_onboarding_worker_should_accept_current_preflight_wording", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-no-docker-wording-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [[ "\${1:-}" = "onboard" ]]; then
  echo "Docker is not reachable. Please fix Docker and try again." >&2
  exit 1
fi
echo "unexpected nemoclaw invocation: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=ubuntu-no-docker-preflight-negative\nE2E_SANDBOX_NAME=e2e-preserved\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        test/e2e-scenario/nemoclaw_scenarios/dispatch-action.sh e2e_onboard cloud-openclaw-no-docker "${ONBOARD_DIR}/dispatch.sh"
      `,
        {
          E2E_ACTION_ID: "onboarding.profile.cloud-openclaw-no-docker",
          E2E_CONTEXT_DIR: tmp,
          E2E_PHASE: "onboarding",
          NVIDIA_API_KEY: "secret-token",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: tmp,
        },
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const logBody = fs.readFileSync(path.join(tmp, "negative-preflight.log"), "utf8");
      expect(logBody).toContain("Docker is not reachable");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no_docker_redactor_fallback_should_redact_sensitive_env_values_without_python", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-no-docker-redactor-"));
    const noPythonBin = path.join(tmp, "bin");
    const logPath = path.join(tmp, "negative-preflight.log");
    try {
      const r = runBash(
        `
        set -euo pipefail
        mkdir -p "${noPythonBin}"
        for cmd in rm mktemp sed env cat mv; do
          ln -s "$(command -v "\${cmd}")" "${noPythonBin}/\${cmd}"
        done
        . "${ONBOARD_DIR}/cloud-openclaw-no-docker.sh"
        export NVIDIA_API_KEY=plain-secret-value
        PATH="${noPythonBin}"
        printf 'plain-secret-value\\nDocker is required before onboarding\\n' | e2e_no_docker_write_redacted_preflight_log "${logPath}"
      `,
        { TMPDIR: tmp },
      );
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      const logBody = fs.readFileSync(logPath, "utf8");
      expect(logBody).toContain("[REDACTED]");
      expect(logBody).toContain("Docker is required before onboarding");
      expect(logBody).not.toContain("plain-secret-value");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_load_with_context_library", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-context-"));
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_CREDENTIALS_EXPECTED=present\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_require_context E2E_SCENARIO E2E_PROVIDER
        echo "provider=$(spc_context_get E2E_PROVIDER)"
        `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("provider=nvidia");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_fail_when_required_context_missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-context-missing-"));
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_require_context E2E_PROVIDER
        `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("E2E_PROVIDER");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_not_log_secret_values", () => {
    const r = runBash(`
      set -euo pipefail
      . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
      spc_log_provider_metadata "nvidia" "primary"
      printf 'token=nvapi-secret-value-1234567890 sk-abcdefghijklmnop\n' | spc_redact_secret_text
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("provider=nvidia name=primary");
    expect(r.stdout).not.toMatch(/nvapi-secret-value|sk-abcdefghijklmnop/);
    expect(r.stdout).toMatch(/\[REDACTED\]/);
  });

  it("security_policy_credentials_helper_should_reject_empty_gateway_credentials", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-credentials-empty-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "credentials list" ]; then
  echo "  No provider credentials registered."
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_CREDENTIALS_EXPECTED=present\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_credentials_expected
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no gateway credentials/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_reject_raw_credential_leaks", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-credentials-leak-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "credentials list" ]; then
  echo "  Providers registered with the OpenShell gateway:"
  echo "    nvidia token=nvapi-secret-value-1234567890"
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_CREDENTIALS_EXPECTED=present\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_credentials_expected
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/secret-looking raw output/i);
      expect(r.stdout).not.toContain("nvapi-secret-value");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_reject_raw_credential_leaks_from_failed_list", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-credentials-failed-leak-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "credentials list" ]; then
  echo "gateway error token=nvapi-secret-value-1234567890" >&2
  exit 1
fi
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_CREDENTIALS_EXPECTED=present\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_credentials_expected
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/secret-looking raw output/i);
      expect(r.stderr).not.toMatch(/credentials list failed/);
      expect(r.stdout).not.toContain("nvapi-secret-value");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_verify_policy_and_shields_state", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-policy-shields-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "sb policy-list" ]; then
  echo "  Policy presets for sandbox 'sb':"
  echo "    ● telegram — Telegram bridge egress"
  echo "    ○ slack — Slack bridge egress"
  exit 0
fi
if [ "$1 $2 $3" = "sb shields status" ]; then
  echo "  Shields: UP (lockdown active)"
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
if [ "$1 $2 $3" = "sandbox exec --name" ]; then
  echo "440 root:root"
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_SANDBOX_NAME=sb\nE2E_AGENT=openclaw\nE2E_SHIELDS_EXPECTED_STATE=up\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_policy_preset_present telegram
        spc_assert_shields_config_consistent
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("telegram");
      expect(r.stdout).toContain("shields config state is consistent: up");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_fail_on_missing_policy_preset", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-policy-missing-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "nemoclaw"),
      `#!/usr/bin/env bash
echo "    slack — Slack bridge egress"
exit 0
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\nE2E_PROVIDER=nvidia\nE2E_SANDBOX_NAME=sb\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_policy_preset_present telegram
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/expected policy preset 'telegram'/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_verify_openshell_rewrite_markers", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-openshell-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
# request-body-credential-rewrite websocket-credential-rewrite
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.39"
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_openshell_credential_rewrite_supported
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("OpenShell 0.0.39 credential rewrite capability markers present");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_policy_credentials_helper_should_reject_below_minimum_openshell_version", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spc-openshell-old-"));
    const fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openshell"),
      `#!/usr/bin/env bash
# request-body-credential-rewrite websocket-credential-rewrite
if [ "$1" = "--version" ]; then
  echo "openshell 0.0.38"
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\n");
      const r = runBash(
        `
        set -euo pipefail
        . "${VALIDATION_SUITES}/lib/security_policy_credentials.sh"
        spc_assert_openshell_credential_rewrite_supported
        `,
        { E2E_CONTEXT_DIR: tmp, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("below credential rewrite minimum");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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

});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.A — Logging helpers (lib/logging.sh)
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuild/upgrade validation helpers", () => {
  it("rebuild_upgrade_library_should_source_without_side_effects", () => {
    const r = runBash(`
      set -euo pipefail
      . "${REBUILD_UPGRADE_LIB}"
      declare -F rebuild_upgrade_require_context >/dev/null
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/install|onboard|rebuild/i);
  });

  it("rebuild_upgrade_context_should_fail_with_missing_key_name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ru-"));
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SCENARIO=test\n");
      const r = runBash(
        `
        . "${REBUILD_UPGRADE_LIB}"
        rebuild_upgrade_require_context
      `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E2E_AGENT|E2E_SANDBOX_NAME|E2E_GATEWAY_URL/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rebuild_upgrade_context_should_pass_when_required_keys_present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ru-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=test\nE2E_AGENT=openclaw\nE2E_SANDBOX_NAME=sb\nE2E_GATEWAY_URL=http://127.0.0.1\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        . "${REBUILD_UPGRADE_LIB}"
        rebuild_upgrade_require_context
      `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status, r.stderr).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rebuild_upgrade_checks_should_allow_command_fakes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ru-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=test\nE2E_AGENT=openclaw\nE2E_SANDBOX_NAME=sb\nE2E_GATEWAY_URL=http://127.0.0.1\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        fake_sandbox() {
          case "$*" in
            *cat*) printf 'marker' ;;
            *version*) printf 'OpenClaw 2.0.0' ;;
            *models*) printf '{"data":[]}' ;;
            *) true ;;
          esac
        }
        . "${REBUILD_UPGRADE_LIB}"
        rebuild_upgrade_assert_marker_preserved
        rebuild_upgrade_assert_agent_version_upgraded
        rebuild_upgrade_assert_inference_works
      `,
        {
          E2E_CONTEXT_DIR: tmp,
          REBUILD_UPGRADE_SANDBOX_CMD: "fake_sandbox",
          E2E_REBUILD_MARKER_EXPECTED: "marker",
          E2E_OLD_AGENT_VERSION: "1.0.0",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("suite.rebuild.workspace_state_preserved");
      expect(r.stdout).toContain("suite.rebuild.agent_version_upgraded");
      expect(r.stdout).toContain("suite.rebuild.inference_still_works");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("policy_preset_check_should_match_endpoint_url_when_preset_name_absent", () => {
    // The legacy assertion called `nemoclaw policy status` (a command
    // that does not exist) and silently failed. The new assertion calls
    // `openshell policy get --full <sandbox>` and matches preset names
    // OR their well-known endpoint hostnames. Verify both paths: a
    // policy output containing only endpoint URLs (no bare preset name)
    // still passes, mirroring the behavior of the live gateway policy
    // dump in test/e2e/test-rebuild-openclaw.sh.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ru-policy-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=test\nE2E_AGENT=openclaw\nE2E_SANDBOX_NAME=sb\nE2E_GATEWAY_URL=http://127.0.0.1\n",
      );
      const r = runBash(
        `
        set -euo pipefail
        fake_openshell() {
          # Emit a minimal policy dump that contains the preset endpoint
          # URLs but NOT the bare preset names. This is the realistic
          # case: 'openshell policy get --full' renders network rules
          # by hostname, not by preset label.
          printf 'allow registry.npmjs.org\\nallow pypi.org\\n'
        }
        . "${REBUILD_UPGRADE_LIB}"
        rebuild_upgrade_assert_policy_presets_preserved
      `,
        {
          E2E_CONTEXT_DIR: tmp,
          REBUILD_UPGRADE_OPENSHELL_CMD: "fake_openshell",
          E2E_EXPECTED_POLICY_PRESETS: "npm pypi",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("suite.rebuild.policy_presets_preserved");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("policy_preset_check_should_fail_with_diagnostic_when_preset_missing", () => {
    // Negative case: when a declared preset is absent from the live
    // policy dump, the assertion must fail AND emit a diagnostic line
    // identifying the missing preset and showing the policy head. The
    // original implementation failed silently because the underlying
    // `nemoclaw policy status` command did not exist; the new
    // implementation must produce actionable evidence.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ru-policy-miss-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "context.env"),
        "E2E_SCENARIO=test\nE2E_AGENT=openclaw\nE2E_SANDBOX_NAME=sb\nE2E_GATEWAY_URL=http://127.0.0.1\n",
      );
      const r = runBash(
        `
        fake_openshell() {
          # Policy dump missing 'pypi' entirely.
          printf 'allow registry.npmjs.org\\n'
        }
        . "${REBUILD_UPGRADE_LIB}"
        rebuild_upgrade_assert_policy_presets_preserved
      `,
        {
          E2E_CONTEXT_DIR: tmp,
          REBUILD_UPGRADE_OPENSHELL_CMD: "fake_openshell",
          E2E_EXPECTED_POLICY_PRESETS: "npm pypi",
        },
      );
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/preset 'pypi' not in policy/);
      expect(r.stdout + r.stderr).toMatch(/matchers: pypi/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

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
    // Use a fake openshell on PATH that executes the command after `--`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-fail-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "openshell"),
        `#!/usr/bin/env bash
set -euo pipefail
while [[ "$#" -gt 0 && "$1" != "--" ]]; do
  shift
done
if [[ "$#" -gt 0 ]]; then
  shift
fi
exec "$@"
`,
        { mode: 0o755 },
      );
      const r = runBash(
        `
        . "${VALIDATION_SUITES}/sandbox-exec.sh"
        e2e_sandbox_exec sb1 -- false
        echo "rc=$?"
      `,
        // Force the openshell-direct transport so the stubbed openshell
        // (which has no `sandbox ssh-config` subcommand) is exercised.
        { PATH: `${bin}:${process.env.PATH}`, E2E_SANDBOX_EXEC_VIA_OPENSHELL: "1" },
      );
      expect(r.stdout).toMatch(/rc=1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sandbox_exec_stdin_should_quote_args_safely_when_piped", () => {
    // Verify that $TOKEN is NOT expanded on the host side before being
    // delivered to the sandbox. We stub openshell to echo back stdin.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-stdin-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      // Fake openshell: when called as `openshell sandbox exec --name sb1 -- cat`
      // read stdin and print it verbatim so the test can see what the sandbox
      // would have received.
      fs.writeFileSync(path.join(bin, "openshell"), '#!/usr/bin/env bash\ncat\n', {
        mode: 0o755,
      });
      const r = runBash(
        `
          set -euo pipefail
          . "${VALIDATION_SUITES}/sandbox-exec.sh"
          printf 'hello $TOKEN' | e2e_sandbox_exec_stdin sb1 -- cat
        `,
        {
          PATH: `${bin}:${process.env.PATH}`,
          TOKEN: "SHOULD_NOT_EXPAND",
          // Stub only handles the openshell-direct transport.
          E2E_SANDBOX_EXEC_VIA_OPENSHELL: "1",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("hello $TOKEN");
      expect(r.stdout).not.toContain("SHOULD_NOT_EXPAND");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sandbox_exec_should_prefer_ssh_config_transport_when_openshell_offers_one", () => {
    // Verify the new default: when `openshell sandbox ssh-config <name>`
    // succeeds, the wrapper routes through `ssh -F <cfg>` instead of
    // `openshell sandbox exec`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-ssh-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      const trace = path.join(tmp, "ssh.trace");
      fs.writeFileSync(
        path.join(bin, "openshell"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "sandbox" && "$2" == "ssh-config" ]]; then
  printf 'Host openshell-%s\\n  HostName 127.0.0.1\\n  Port 2222\\n  User sandbox\\n' "$3"
  exit 0
fi
echo "unexpected openshell call: $*" >&2
exit 99
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(bin, "ssh"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "ssh-args:$*" >> "${trace}"
remote="\${@: -1}"
printf '%s\\n' "remote-cmd:\${remote}" >> "${trace}"
echo ok-from-ssh
exit 0
`,
        { mode: 0o755 },
      );
      const ctxDir = path.join(tmp, "ctx");
      fs.mkdirSync(ctxDir);
      const r = runBash(
        `
          set -euo pipefail
          . "${VALIDATION_SUITES}/sandbox-exec.sh"
          e2e_sandbox_exec sb1 -- echo hello
        `,
        {
          PATH: `${bin}:${process.env.PATH}`,
          E2E_CONTEXT_DIR: ctxDir,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("ok-from-ssh");
      const traceContents = fs.readFileSync(trace, "utf8");
      expect(traceContents).toMatch(/ssh-args:.*-F /);
      expect(traceContents).toContain("openshell-sb1");
      expect(traceContents).toMatch(/remote-cmd:echo hello$/m);
      const cfg = path.join(ctxDir, ".ssh-config-cache", "sb1.cfg");
      expect(fs.existsSync(cfg)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sandbox_exec_should_fall_back_to_openshell_when_ssh_config_unavailable", () => {
    // If `openshell sandbox ssh-config` fails, the wrapper must fall
    // back to `openshell sandbox exec`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sbex-fb-"));
    try {
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(
        path.join(bin, "openshell"),
        `#!/usr/bin/env bash
set -uo pipefail
if [[ "$1" == "sandbox" && "$2" == "ssh-config" ]]; then
  exit 1
fi
if [[ "$1" == "sandbox" && "$2" == "exec" ]]; then
  shift 2
  while [[ "$#" -gt 0 && "$1" != "--" ]]; do shift; done
  shift || true
  exec "$@"
fi
exit 99
`,
        { mode: 0o755 },
      );
      const ctxDir = path.join(tmp, "ctx");
      fs.mkdirSync(ctxDir);
      const r = runBash(
        `
          set -euo pipefail
          . "${VALIDATION_SUITES}/sandbox-exec.sh"
          e2e_sandbox_exec sb1 -- echo fallback-ok
        `,
        {
          PATH: `${bin}:${process.env.PATH}`,
          E2E_CONTEXT_DIR: ctxDir,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("fallback-ok");
      expect(r.stderr).toMatch(/ssh-config unavailable for sb1/);
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
// Issue #3810 Phase 1 — Messaging provider primitive library
// ─────────────────────────────────────────────────────────────────────────────

describe("Issue #3810 messaging provider helper library", () => {
  function withContext(values: Record<string, string>): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-msgctx-"));
    fs.writeFileSync(
      path.join(tmp, "context.env"),
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
    return tmp;
  }

  it("should_source_messaging_provider_library_in_isolation", () => {
    const r = runBash(`
      set -euo pipefail
      . "${VALIDATION_LIB}/messaging_providers.sh"
      declare -F e2e_messaging_load_context
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("e2e_messaging_load_context");
  });

  it("should_fail_with_clear_diagnostic_when_context_missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-msgmissing-"));
    fs.rmSync(tmp, { recursive: true, force: true });
    const r = runBash(
      `
        set -euo pipefail
        . "${VALIDATION_LIB}/messaging_providers.sh"
        e2e_messaging_load_context
      `,
      { E2E_CONTEXT_DIR: tmp },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/E2E_CONTEXT_DIR|context\.env/);
  });

  it("should_derive_provider_names_for_messaging_channels", () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ["telegram", { E2E_AGENT: "openclaw", E2E_MESSAGING_PROVIDER: "telegram" }, "telegram"],
      ["discord", { E2E_AGENT: "openclaw", E2E_MESSAGING_PROVIDER: "discord" }, "discord"],
      ["slack-bot", { E2E_AGENT: "openclaw", E2E_MESSAGING_PROVIDER: "slack", E2E_MESSAGING_CHANNEL: "bot" }, "slack-bot"],
      ["slack-app", { E2E_AGENT: "openclaw", E2E_MESSAGING_PROVIDER: "slack", E2E_MESSAGING_CHANNEL: "app" }, "slack-app"],
      ["whatsapp", { E2E_AGENT: "openclaw", E2E_MESSAGING_PROVIDER: "whatsapp" }, "whatsapp-qr"],
    ];
    for (const [name, values, expected] of cases) {
      const ctx = withContext({ E2E_SANDBOX_NAME: "sb", ...values });
      try {
        const r = runBash(
          `
            set -euo pipefail
            . "${VALIDATION_LIB}/messaging_providers.sh"
            e2e_messaging_load_context >/dev/null
            e2e_messaging_provider_name
          `,
          { E2E_CONTEXT_DIR: ctx },
        );
        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
        expect(r.stdout.trim()).toBe(expected);
      } finally {
        fs.rmSync(ctx, { recursive: true, force: true });
      }
    }
  });

  it("should_resolve_agent_config_paths", () => {
    const cases: Array<[string, string]> = [
      ["openclaw", "/sandbox/.openclaw/openclaw.json"],
      ["hermes", "/sandbox/.hermes/.env"],
    ];
    for (const [agent, expected] of cases) {
      const ctx = withContext({ E2E_SANDBOX_NAME: "sb", E2E_AGENT: agent, E2E_MESSAGING_PROVIDER: "discord" });
      try {
        const r = runBash(
          `
            set -euo pipefail
            . "${VALIDATION_LIB}/messaging_providers.sh"
            e2e_messaging_load_context >/dev/null
            e2e_messaging_agent_config_path
          `,
          { E2E_CONTEXT_DIR: ctx },
        );
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.trim()).toBe(expected);
      } finally {
        fs.rmSync(ctx, { recursive: true, force: true });
      }
    }
  });

  it("should_expose_placeholder_and_secret_leak_interfaces_without_live_secrets", () => {
    const r = runBash(`
      set -euo pipefail
      . "${VALIDATION_LIB}/messaging_providers.sh"
      e2e_messaging_assert_placeholder_configured 'token=\${TELEGRAM_BOT_TOKEN}' 'TELEGRAM_BOT_TOKEN'
      e2e_messaging_assert_no_secret_leak 'safe placeholder \${TELEGRAM_BOT_TOKEN}' 'raw-secret-123'
      if e2e_messaging_assert_no_secret_leak 'oops raw-secret-123' 'raw-secret-123'; then
        echo unexpected-pass
        exit 1
      fi
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("unexpected-pass");
  });
});

describe("baseline onboarding validation helper", () => {
  it("baseline_helper_should_source_under_strict_shell_options", () => {
    const r = runBash(`set -euo pipefail; source "${VALIDATION_SUITES}/lib/baseline_onboarding.sh"`);
    expect(r.status, r.stderr).toBe(0);
  });

  it("baseline_cli_assertions_should_use_mocked_binaries", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-cli-"));
    try {
      const bin = path.join(tmp, "bin");
      const ctx = path.join(tmp, "ctx");
      fs.mkdirSync(bin); fs.mkdirSync(ctx);
      fs.writeFileSync(path.join(ctx, "context.env"), "E2E_SANDBOX_NAME=sb1\nE2E_PROVIDER=nvidia\nE2E_INFERENCE_ROUTE=inference-local\n");
      fs.writeFileSync(path.join(bin, "nemoclaw"), `#!/usr/bin/env bash
case "$*" in
  --help) echo help;;
  "sb1 status") echo 'status running gateway healthy sandbox running';;
  "sb1 logs") echo baseline-log;;
  *) echo "unexpected nemoclaw args: $*" >&2; exit 64;;
esac
`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      const r = runBash(`
        set -euo pipefail
        source "${VALIDATION_SUITES}/lib/baseline_onboarding.sh"
        baseline_onboarding_load_context
        baseline_assert_nemoclaw_on_path
        baseline_assert_openshell_on_path
        baseline_assert_nemoclaw_help_exits_zero
        baseline_assert_sandbox_status_exits_zero
        baseline_assert_logs_produce_output
      `, { E2E_CONTEXT_DIR: ctx, PATH: `${bin}:${process.env.PATH}` });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("PASS: validation.baseline_onboarding.nemoclaw_on_path");
      expect(r.stdout).toContain("PASS: validation.baseline_onboarding.openshell_on_path");
      expect(r.stdout).toContain("PASS: validation.baseline_onboarding.nemoclaw_help_exits_zero");
      expect(r.stdout).toContain("PASS: validation.baseline_onboarding.sandbox_status");
      expect(r.stdout).toContain("PASS: validation.baseline_onboarding.logs_available");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("sandbox lifecycle validation helper", () => {
  it("test_should_load_context_from_e2e_context_dir", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-life-"));
    try {
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SANDBOX_NAME=sb1\nE2E_GATEWAY_URL=http://127.0.0.1:1\n");
      const r = runBash(`set -euo pipefail; . "${VALIDATION_SUITES}/lib/sandbox_lifecycle.sh"; sandbox_lifecycle_load_context; echo "$E2E_SANDBOX_NAME $E2E_GATEWAY_URL"`, { E2E_CONTEXT_DIR: tmp });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("sb1 http://127.0.0.1:1");
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("test_should_emit_stable_pass_and_fail_ids", () => {
    const r = runBash(`. "${VALIDATION_SUITES}/lib/sandbox_lifecycle.sh"; sandbox_lifecycle_pass validation.sandbox_lifecycle.gateway_health ok; sandbox_lifecycle_fail validation.sandbox_operations.logs_available nope`);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/PASS: validation\.sandbox_lifecycle\.gateway_health/);
    expect(r.stderr).toMatch(/FAIL: validation\.sandbox_operations\.logs_available/);
  });

  it("test_should_apply_timeout_to_command_execution", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-life-timeout-"));
    try {
      const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "timeout"), "#!/usr/bin/env bash\necho timed out >&2\nexit 124\n", { mode: 0o755 });
      const r = runBash(`set -e; . "${VALIDATION_SUITES}/lib/sandbox_lifecycle.sh"; sandbox_lifecycle_run_with_timeout 1 bash -c 'sleep 5'`, { PATH: `${bin}:${process.env.PATH}` });
      expect(r.status).toBe(124);
      expect(r.stderr).toMatch(/timed out/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it("test_should_validate_list_status_logs_exec_with_mocked_commands", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-life-mock-"));
    try {
      const bin = path.join(tmp, "bin"); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "nemoclaw"), `#!/usr/bin/env bash
case "$*" in
  list) echo sb1;;
  "sb1 status") printf '  Sandbox: sb1\\n    Model:    nvidia/x\\n    OpenShell: 0.0.44\\n    Policies: npm\\n';;
  "sb1 logs") echo logline;;
  *) echo "unexpected nemoclaw args: $*" >&2; exit 64;;
esac
`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "openshell"), `#!/usr/bin/env bash
echo lifecycle-ok
`, { mode: 0o755 });
      fs.writeFileSync(path.join(tmp, "context.env"), "E2E_SANDBOX_NAME=sb1\nE2E_GATEWAY_URL=http://127.0.0.1:1\n");
      // Force the wrapper's openshell-exec fallback transport: this
      // stub openshell ignores its argv and always echoes 'lifecycle-ok',
      // which would corrupt an ssh-config materialization. The opt-out
      // env var keeps the test exercising openshell-exec directly while
      // production callers still pick up ssh-config-preferred routing.
      const r = runBash(`set -euo pipefail; . "${VALIDATION_SUITES}/lib/sandbox_lifecycle.sh"; sandbox_lifecycle_load_context; sandbox_lifecycle_assert_nemoclaw_list_contains_sandbox; sandbox_lifecycle_assert_status_fields_present; sandbox_lifecycle_assert_logs_available; sandbox_lifecycle_assert_openshell_exec_ok`, { E2E_CONTEXT_DIR: tmp, PATH: `${bin}:${process.env.PATH}`, E2E_SANDBOX_EXEC_VIA_OPENSHELL: "1" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/validation\.sandbox_operations\.sandbox_listed/);
      expect(r.stdout).toMatch(/validation\.sandbox_operations\.openshell_exec_ok/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
