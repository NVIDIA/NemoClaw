// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RUN_SUITES = path.join(REPO_ROOT, "test/e2e/runtime/run-suites.sh");

function runSuites(args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", [RUN_SUITES, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

function seedContext(tmp: string, values: Record<string, string>): void {
  fs.mkdirSync(tmp, { recursive: true });
  const ctx = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(path.join(tmp, "context.env"), `${ctx}\n`);
}

function fullContext(): Record<string, string> {
  return {
    E2E_SCENARIO: "ubuntu-repo-cloud-openclaw",
    E2E_PLATFORM_OS: "ubuntu",
    E2E_EXECUTION_TARGET: "local",
    E2E_INSTALL_METHOD: "repo-checkout",
    E2E_CONTAINER_ENGINE: "docker",
    E2E_CONTAINER_DAEMON: "running",
    E2E_ONBOARDING_PATH: "cloud",
    E2E_AGENT: "openclaw",
    E2E_PROVIDER: "nvidia",
    E2E_SANDBOX_NAME: "e2e-ubuntu-repo-cloud-openclaw",
    E2E_GATEWAY_URL: "http://127.0.0.1:18789",
    E2E_INFERENCE_ROUTE: "inference-local",
  };
}

function hermesContext(): Record<string, string> {
  return {
    ...fullContext(),
    E2E_SCENARIO: "ubuntu-repo-cloud-hermes",
    E2E_AGENT: "hermes",
    E2E_SANDBOX_NAME: "e2e-ubuntu-repo-cloud-hermes",
  };
}

describe("Issue #3810 messaging suite wiring", () => {
  it("should_define_real_steps_for_messaging_provider_suites", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-messaging-suites-"));
    try {
      const baseContext = {
        ...fullContext(),
        E2E_PROVIDER: "telegram",
        E2E_MESSAGING_PROVIDER: "telegram",
        E2E_MESSAGING_BRIDGE_URL: "http://127.0.0.1:18789",
        E2E_MESSAGING_CONFIG_CONTENT: "TELEGRAM_BOT_TOKEN=PLACEHOLDER",
      };
      seedContext(tmp, baseContext);
      const telegram = runSuites(["messaging-telegram"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN: "1",
      });
      expect(telegram.status, `stderr:${telegram.stderr}\nstdout:${telegram.stdout}`).toBe(0);
      seedContext(tmp, {
        ...baseContext,
        E2E_MESSAGING_PROVIDER: "discord",
        E2E_MESSAGING_CONFIG_CONTENT: "DISCORD_BOT_TOKEN=PLACEHOLDER",
      });
      const discord = runSuites(["messaging-discord"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN: "1",
      });
      expect(discord.status, `stderr:${discord.stderr}\nstdout:${discord.stdout}`).toBe(0);
      seedContext(tmp, {
        ...baseContext,
        E2E_MESSAGING_PROVIDER: "slack",
        E2E_MESSAGING_CHANNEL: "bot",
        E2E_MESSAGING_CONFIG_CONTENT: "SLACK_BOT_TOKEN=PLACEHOLDER",
      });
      const slack = runSuites(["messaging-slack"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN: "1",
      });
      expect(slack.status, `stderr:${slack.stderr}\nstdout:${slack.stdout}`).toBe(0);
      const output = `${telegram.stdout}\n${discord.stdout}\n${slack.stdout}`;
      for (const id of [
        "messaging-provider-attached",
        "messaging-placeholder-configured",
        "messaging-no-secret-leak",
        "messaging-bridge-reachable",
        "telegram-injection-safety",
        "discord-gateway-path",
        "slack-provider-state",
      ]) {
        expect(output).toContain(id);
      }
      expect(output).not.toContain("cli-available");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("run-suites.sh", () => {
  it("test_should_emit_hermes_runtime_assertion_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-runtime-"));
    try {
      seedContext(tmp, {
        ...hermesContext(),
        E2E_PROVIDER_API_KEY: "super-secret-hermes-token",
        SLACK_BOT_TOKEN: "xoxb-secret-token",
      });
      const r = runSuites(["hermes-runtime"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      for (const id of [
        "expected.hermes.runtime.gateway-health",
        "expected.hermes.runtime.agent-home",
        "expected.hermes.runtime.env-integrity",
        "expected.hermes.runtime.security-posture",
      ]) {
        expect(r.stdout).toContain(id);
      }
      expect(r.stdout + r.stderr).not.toContain("super-secret-hermes-token");
      expect(r.stdout + r.stderr).not.toContain("xoxb-secret-token");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("test_should_emit_hermes_inference_switch_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-inference-"));
    try {
      seedContext(tmp, hermesContext());
      const r = runSuites(["hermes-inference-switch"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      for (const id of [
        "expected.hermes.inference.switch-route-state",
        "expected.hermes.inference.env-immutable-on-switch",
        "expected.hermes.inference.gateway-pid-stable",
        "expected.hermes.inference.inference-local-chat",
        "expected.hermes.inference.hermes-api-chat",
        "expected.hermes.inference.external-timeout-classification",
      ]) {
        expect(r.stdout).toContain(id);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("test_should_emit_hermes_messaging_assertion_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-msg-"));
    try {
      const cases: Array<[string, string[]]> = [
        ["hermes-discord", [
          "expected.hermes.discord.config-schema",
          "expected.hermes.discord.policy-egress",
          "expected.hermes.discord.gateway-connects",
          "expected.hermes.discord.empty-user-allowlist-open-dm-policy",
          "expected.hermes.discord.no-openclaw-pairing-copy",
          "expected.hermes.discord.plugin-entry-registered",
        ]],
        ["hermes-slack", [
          "expected.hermes.slack.config-enabled",
          "expected.hermes.slack.provider-state",
          "expected.hermes.slack.socket-mode-starts",
          "expected.hermes.slack.no-secret-leak",
          "expected.hermes.slack.idle-reconnect-delivers-first-mention",
        ]],
        ["hermes-telegram", [
          "expected.hermes.telegram.first-message-tool-dispatch",
          "expected.hermes.telegram.single-polling-loop",
          "expected.hermes.telegram.privacy-mode-guidance",
          "expected.hermes.telegram.group-message-preconditions",
        ]],
      ];
      for (const [suite, ids] of cases) {
        seedContext(tmp, { ...hermesContext(), E2E_MESSAGING_PROVIDER: suite.replace("hermes-", ""), SLACK_BOT_TOKEN: "xoxb-secret-token", DISCORD_BOT_TOKEN: "discord-secret-token", TELEGRAM_BOT_TOKEN: "telegram-secret-token" });
        const r = runSuites([suite], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
        expect(r.status, `suite:${suite}\nstderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
        for (const id of ids) expect(r.stdout).toContain(id);
        expect(r.stdout + r.stderr).not.toContain("xoxb-secret-token");
        expect(r.stdout + r.stderr).not.toContain("discord-secret-token");
        expect(r.stdout + r.stderr).not.toContain("telegram-secret-token");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("test_should_emit_hermes_rebuild_assertion_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-rebuild-"));
    try {
      seedContext(tmp, hermesContext());
      const r = runSuites(["hermes-rebuild"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      for (const id of [
        "expected.hermes.rebuild.provider-credential-reused",
        "expected.hermes.rebuild.messaging-config-preserved",
        "expected.hermes.rebuild.dashboard-forward-released",
        "expected.hermes.rebuild.post-rebuild-health",
      ]) expect(r.stdout).toContain(id);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("test_should_emit_hermes_policy_provider_security_tui_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-remaining-"));
    try {
      const cases: Array<[string, string[]]> = [
        ["hermes-policy", [
          "expected.hermes.policy.inactive-messaging-not-preenabled",
          "expected.hermes.policy.managed-inference-anthropic-messages-path",
          "expected.hermes.policy.venv-python-egress",
          "expected.hermes.policy.no-phantom-allowlist",
        ]],
        ["hermes-provider-compatibility", [
          "expected.hermes.provider.anthropic-compatible-chat",
          "expected.hermes.provider.gemini-tool-schema-compatible",
          "expected.hermes.provider.onboard-smoke-not-sufficient",
        ]],
        ["hermes-security-tui", [
          "expected.hermes.security.shields-up-down-macos-vm-driver",
          "expected.hermes.security.shields-config-locked",
          "expected.hermes.tui.history-writable",
        ]],
      ];
      for (const [suite, ids] of cases) {
        seedContext(tmp, hermesContext());
        const r = runSuites([suite], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
        expect(r.status, `suite:${suite}\nstderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
        for (const id of ids) expect(r.stdout).toContain(id);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("security_credentials_suite_should_emit_stable_assertion_ids", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-security-credentials-"));
    try {
      seedContext(tmp, { ...fullContext(), E2E_CREDENTIALS_EXPECTED: "present" });
      const r = runSuites(["security-credentials"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1", HOME: tmp });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      expect(r.stdout).toContain("post-onboard.credentials.gateway-list-redacts-values");
      expect(r.stdout).toContain("post-onboard.credentials.no-plaintext-host-store");
      expect(r.stdout).not.toMatch(/no-credentials-leaked|assert\//);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_suites_should_run_steps_in_declared_order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      seedContext(tmp, fullContext());
      const r = runSuites(["smoke"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_DRY_RUN: "1",
      });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      // Smoke order is: cli-available, gateway-health, sandbox-listed, sandbox-shell
      const order = ["cli-available", "gateway-health", "sandbox-listed", "sandbox-shell"];
      let pos = 0;
      for (const marker of order) {
        const idx = r.stdout.indexOf(marker, pos);
        expect(idx, `missing marker ${marker} after ${pos} in:\n${r.stdout}`).toBeGreaterThanOrEqual(0);
        pos = idx + marker.length;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_suites_should_fail_on_unknown_suite", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      seedContext(tmp, fullContext());
      const r = runSuites(["does-not-exist"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/does-not-exist/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("run_suites_should_stop_on_first_failed_step", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      seedContext(tmp, fullContext());
      // Use a fixture suites file with a failing middle step.
      const fixtureSuites = path.join(tmp, "suites.yaml");
      const fixtureDir = path.join(tmp, "suites", "fixture");
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, "00-a.sh"), "#!/usr/bin/env bash\necho A-RAN\nexit 0\n");
      fs.writeFileSync(path.join(fixtureDir, "01-b.sh"), "#!/usr/bin/env bash\necho B-RAN\nexit 1\n");
      fs.writeFileSync(path.join(fixtureDir, "02-c.sh"), "#!/usr/bin/env bash\necho C-RAN\nexit 0\n");
      fs.chmodSync(path.join(fixtureDir, "00-a.sh"), 0o755);
      fs.chmodSync(path.join(fixtureDir, "01-b.sh"), 0o755);
      fs.chmodSync(path.join(fixtureDir, "02-c.sh"), 0o755);
      fs.writeFileSync(
        fixtureSuites,
        `suites:
  fixture:
    steps:
      - { id: a, script: suites/fixture/00-a.sh }
      - { id: b, script: suites/fixture/01-b.sh }
      - { id: c, script: suites/fixture/02-c.sh }
`,
      );
      const r = runSuites(["fixture"], {
        E2E_CONTEXT_DIR: tmp,
        E2E_SUITES_FILE: fixtureSuites,
        E2E_SUITES_DIR: tmp,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain("A-RAN");
      expect(r.stdout).toContain("B-RAN");
      expect(r.stdout).not.toContain("C-RAN");
      expect(`${r.stdout}${r.stderr}`).toMatch(/FAIL.*(fixture\/b|step=b)/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("smoke_suite_should_require_context", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      // No context.env written to tmp.
      const r = runSuites(["smoke"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}${r.stdout}`).toMatch(/context\.env|E2E_SCENARIO|missing/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rebuild_and_upgrade_suites_should_emit_stable_assertion_ids_in_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      seedContext(tmp, fullContext());
      const r = runSuites(["rebuild", "upgrade"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      for (const id of [
        "suite.rebuild.workspace_state_preserved",
        "suite.rebuild.agent_version_upgraded",
        "suite.rebuild.inference_still_works",
        "suite.rebuild.policy_presets_preserved",
        "suite.rebuild.hermes_config_preserved",
        "suite.upgrade.sandbox_registry_preserved",
        "suite.upgrade.gateway_version_upgraded",
        "suite.upgrade.survivor_agent_reachable",
      ]) {
        expect(r.stdout).toContain(id);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("smoke_and_inference_run_with_stub_context", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-suite-"));
    try {
      seedContext(tmp, fullContext());
      const r = runSuites(["smoke", "inference"], { E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" });
      expect(r.status, `stderr:${r.stderr}\nstdout:${r.stdout}`).toBe(0);
      for (const id of [
        "cli-available",
        "gateway-health",
        "sandbox-listed",
        "sandbox-shell",
        "models-health",
        "chat-completion",
        "sandbox-inference-local",
      ]) {
        expect(r.stdout).toContain(id);
      }
      // Summary should call out PASS for each step.
      expect(r.stdout).toMatch(/PASS/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
