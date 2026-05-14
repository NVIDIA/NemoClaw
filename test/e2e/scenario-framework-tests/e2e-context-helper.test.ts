// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CONTEXT_LIB = path.join(REPO_ROOT, "test/e2e/runtime/lib/context.sh");
const RUN_SCENARIO = path.join(REPO_ROOT, "test/e2e/runtime/run-scenario.sh");

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

describe("E2E context helper (runtime/lib/context.sh)", () => {
  it("context_should_write_and_source_values", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ctx-"));
    try {
      const script = `
        set -euo pipefail
        . "${CONTEXT_LIB}"
        export E2E_CONTEXT_DIR="${tmp}"
        e2e_context_init
        e2e_context_set E2E_SCENARIO ubuntu-repo-cloud-openclaw
        e2e_context_set E2E_AGENT openclaw
        # In a fresh shell, source the context and print the values.
        bash -c 'set -euo pipefail; . "${tmp}/context.env"; echo "SCENARIO=$E2E_SCENARIO"; echo "AGENT=$E2E_AGENT"'
      `;
      const r = runBash(script);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("SCENARIO=ubuntu-repo-cloud-openclaw");
      expect(r.stdout).toContain("AGENT=openclaw");
      expect(fs.existsSync(path.join(tmp, "context.env"))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("context_require_should_fail_for_missing_value", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ctx-"));
    try {
      const script = `
        set -euo pipefail
        . "${CONTEXT_LIB}"
        export E2E_CONTEXT_DIR="${tmp}"
        e2e_context_init
        e2e_context_require E2E_SANDBOX_NAME
      `;
      const r = runBash(script);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E2E_SANDBOX_NAME/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("context_dump_should_redact_sensitive_values", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ctx-"));
    try {
      const script = `
        set -euo pipefail
        . "${CONTEXT_LIB}"
        export E2E_CONTEXT_DIR="${tmp}"
        e2e_context_init
        e2e_context_set E2E_SCENARIO ubuntu-repo-cloud-openclaw
        e2e_context_set NVIDIA_API_KEY super-secret-api-key-value
        e2e_context_set OPENAI_API_TOKEN nothing-to-see-here-token
        e2e_context_dump
      `;
      const r = runBash(script);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain("super-secret-api-key-value");
      expect(r.stdout).not.toContain("nothing-to-see-here-token");
      expect(r.stdout).toMatch(/NVIDIA_API_KEY=.*REDACTED/);
      expect(r.stdout).toContain("ubuntu-repo-cloud-openclaw");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scenario_plan_execution_should_emit_context_under_dry_run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ctx-"));
    try {
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--dry-run"],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      const ctxPath = path.join(tmp, "context.env");
      expect(fs.existsSync(ctxPath), `context.env missing in ${tmp}`).toBe(true);
      const ctx = fs.readFileSync(ctxPath, "utf8");
      for (const key of [
        "E2E_SCENARIO",
        "E2E_PLATFORM_OS",
        "E2E_INSTALL_METHOD",
        "E2E_ONBOARDING_PATH",
        "E2E_AGENT",
        "E2E_PROVIDER",
        "E2E_SANDBOX_NAME",
        "E2E_GATEWAY_URL",
        "E2E_INFERENCE_ROUTE",
      ]) {
        expect(ctx, `${key} missing from context.env`).toMatch(new RegExp(`^${key}=`, "m"));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
