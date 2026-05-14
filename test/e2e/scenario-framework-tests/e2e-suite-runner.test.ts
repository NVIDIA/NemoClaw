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

describe("run-suites.sh", () => {
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
