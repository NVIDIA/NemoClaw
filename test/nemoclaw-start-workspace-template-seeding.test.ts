// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunctionFromSource(src: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = src.match(new RegExp(`${escapedName}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("nemoclaw-start workspace template seeding", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("round-trips seed_default_workspace_templates through bash -c and seeds templates", () => {
    const fn = extractShellFunctionFromSource(src, "seed_default_workspace_templates");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workspace-seed-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    const configPath = path.join(tmpDir, "openclaw.json");
    fs.mkdirSync(workspaceDir);
    fs.mkdirSync(templatesDir);
    fs.writeFileSync(
      path.join(templatesDir, "AGENTS.md"),
      ["---", "title: template", "---", "Seeded agents template", ""].join("\n"),
    );
    fs.writeFileSync(path.join(templatesDir, "BOOTSTRAP.md"), "should not seed\n");
    fs.writeFileSync(configPath, '{"agents":{"defaults":{"skipBootstrap":true}}}\n');

    try {
      const script = [
        "set -euo pipefail",
        fn,
        `bash -c "$(declare -f seed_default_workspace_templates); seed_default_workspace_templates ${shellQuote(workspaceDir)} ${shellQuote(templatesDir)} ${shellQuote(configPath)}"`,
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("seeded 1 default workspace template");
      expect(fs.readFileSync(path.join(workspaceDir, "AGENTS.md"), "utf-8")).toBe(
        "Seeded agents template\n",
      );
      expect(fs.existsSync(path.join(workspaceDir, "BOOTSTRAP.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
