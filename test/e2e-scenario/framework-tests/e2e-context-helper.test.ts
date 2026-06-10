// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CONTEXT_LIB = path.join(REPO_ROOT, "test/e2e-scenario/runtime/lib/context.sh");

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["--noprofile", "--norc"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    input: script,
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

describe("E2E context helper (runtime/lib/context.sh)", () => {
  it("context helper writes and sources values", () => {
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

  it("context require fails for missing values", () => {
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

  it("context dump redacts sensitive values", () => {
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
});
