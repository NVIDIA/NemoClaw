// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const CHECK_DOCS = path.join(REPO_ROOT, "test", "e2e", "e2e-cloud-experimental", "check-docs.sh");

describe("public compiled CLI contracts", () => {
  it("prints the public NemoClaw version prefix (#7616)", () => {
    const result = spawnSync(process.execPath, [CLI_ENTRYPOINT, "--version"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^nemoclaw v/);
  });

  it("keeps compiled CLI commands aligned with their documentation headings (#7616)", {
    timeout: 150_000,
  }, () => {
    // `npm run test:package` builds the CLI before this project, so the shim
    // exercises the same compiled entrypoint shipped by the package.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docs-cli-parity-"));
    const binDir = path.join(fixtureRoot, "bin");
    const shim = path.join(binDir, "nemoclaw");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      shim,
      `#!/usr/bin/env bash
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI_ENTRYPOINT)} "$@"
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", [CHECK_DOCS, "--only-cli"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          CHECK_DOC_LINKS_REMOTE: "0",
          HOME: fixtureRoot,
          NODE: process.execPath,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        killSignal: "SIGKILL",
        timeout: 120_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("check-docs: running: [cli]");
      expect(result.stdout).toContain("command-level parity OK");
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("validates every repository-local documentation link (#7616)", {
    timeout: 150_000,
  }, () => {
    const result = spawnSync("bash", [CHECK_DOCS, "--only-links", "--local-only"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        CHECK_DOC_LINKS_REMOTE: "0",
      },
      killSignal: "SIGKILL",
      timeout: 120_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("check-docs: running: [links]");
    expect(result.stdout).toContain("remote: skipped (local paths only)");
    expect(result.stdout).toContain("phase 2/2: skipped");
  });
});
