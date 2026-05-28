// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const exporter = path.join(repoRoot, "scripts", "export-catalog-skills.py");
const sourceRoot = path.join(repoRoot, ".agents", "skills");

function listSkillDirs(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("catalog skills export", () => {
  it("allows the export to be absent before the first refresh PR", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-catalog-missing-"),
    );
    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      const tempAgents = path.join(tempDir, ".agents");
      const tempScripts = path.join(tempDir, "scripts");
      fs.mkdirSync(tempAgents, { recursive: true });
      fs.mkdirSync(tempScripts, { recursive: true });
      fs.cpSync(sourceRoot, path.join(tempAgents, "skills"), {
        recursive: true,
      });
      fs.copyFileSync(
        path.join(repoRoot, ".agents", "catalog-skills.yaml"),
        path.join(tempAgents, "catalog-skills.yaml"),
      );
      fs.copyFileSync(
        exporter,
        path.join(tempScripts, "export-catalog-skills.py"),
      );

      const output = execFileSync(
        "python3",
        [
          path.join(tempScripts, "export-catalog-skills.py"),
          "--check",
          "--allow-missing",
        ],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      expect(output).toContain("Catalog export is not present yet");
    } finally {
      cleanup();
    }
  });

  it("preserves existing signing artifacts when regenerating", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-catalog-export-"),
    );
    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      const tempAgents = path.join(tempDir, ".agents");
      const tempScripts = path.join(tempDir, "scripts");
      const tempSkills = path.join(tempDir, "skills");
      fs.mkdirSync(tempAgents, { recursive: true });
      fs.mkdirSync(tempScripts, { recursive: true });
      fs.cpSync(sourceRoot, path.join(tempAgents, "skills"), {
        recursive: true,
      });
      fs.copyFileSync(
        path.join(repoRoot, ".agents", "catalog-skills.yaml"),
        path.join(tempAgents, "catalog-skills.yaml"),
      );
      fs.copyFileSync(
        exporter,
        path.join(tempScripts, "export-catalog-skills.py"),
      );

      const signedSkill = path.join(tempSkills, "nemoclaw-user-get-started");
      fs.mkdirSync(signedSkill, { recursive: true });
      fs.writeFileSync(path.join(signedSkill, "skill.oms.sig"), "signature\n");
      fs.writeFileSync(
        path.join(signedSkill, "skill-card.md"),
        "# Signed card\n",
      );

      execFileSync(
        "python3",
        [path.join(tempScripts, "export-catalog-skills.py")],
        {
          cwd: tempDir,
          encoding: "utf8",
        },
      );

      expect(
        fs.readFileSync(path.join(signedSkill, "skill.oms.sig"), "utf8"),
      ).toBe("signature\n");
      expect(
        fs.readFileSync(path.join(signedSkill, "skill-card.md"), "utf8"),
      ).toBe("# Signed card\n");
      expect(listSkillDirs(tempSkills)).toEqual([
        "nemoclaw-skills-guide",
        "nemoclaw-user-agent-skills",
        "nemoclaw-user-configure-inference",
        "nemoclaw-user-configure-security",
        "nemoclaw-user-deploy-remote",
        "nemoclaw-user-get-started",
        "nemoclaw-user-manage-policy",
        "nemoclaw-user-manage-sandboxes",
        "nemoclaw-user-monitor-sandbox",
        "nemoclaw-user-overview",
        "nemoclaw-user-reference",
      ]);
    } finally {
      cleanup();
    }
  });

  it("rejects unsafe allowlist path fragments", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-catalog-config-"),
    );
    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      const config = path.join(tempDir, "catalog-skills.yaml");
      fs.writeFileSync(
        config,
        [
          "version: 1",
          "source: ../outside",
          "export: skills",
          "include:",
          "  - skill: ../escape",
          "",
        ].join("\n"),
      );

      expect(() =>
        execFileSync("python3", [exporter, "--allowlist", config, "--check"], {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: "pipe",
        }),
      ).toThrow(/source must be a safe relative path/);
    } finally {
      cleanup();
    }
  });

  it("fails when preserved signing artifacts are not copied into the final export", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-catalog-export-"),
    );
    const cleanup = () => fs.rmSync(tempDir, { recursive: true, force: true });

    try {
      const tempAgents = path.join(tempDir, ".agents");
      const tempScripts = path.join(tempDir, "scripts");
      const tempSkills = path.join(tempDir, "skills");
      fs.mkdirSync(tempAgents, { recursive: true });
      fs.mkdirSync(tempScripts, { recursive: true });
      fs.cpSync(sourceRoot, path.join(tempAgents, "skills"), {
        recursive: true,
      });
      fs.copyFileSync(
        path.join(repoRoot, ".agents", "catalog-skills.yaml"),
        path.join(tempAgents, "catalog-skills.yaml"),
      );
      const tempExporter = path.join(tempScripts, "export-catalog-skills.py");
      fs.copyFileSync(exporter, tempExporter);
      let exporterSource = fs.readFileSync(tempExporter, "utf8");
      exporterSource = exporterSource.replace(
        "def preserve_signing_artifacts(\n    existing_root: Path, temp_root: Path, skills: tuple[str, ...]\n) -> None:",
        "def preserve_signing_artifacts(\n    existing_root: Path, temp_root: Path, skills: tuple[str, ...]\n) -> None:\n    return",
      );
      fs.writeFileSync(tempExporter, exporterSource);

      const signedSkill = path.join(tempSkills, "nemoclaw-user-get-started");
      fs.mkdirSync(signedSkill, { recursive: true });
      fs.writeFileSync(path.join(signedSkill, "skill.oms.sig"), "signature\n");

      expect(() =>
        execFileSync("python3", [tempExporter], {
          cwd: tempDir,
          encoding: "utf8",
          stdio: "pipe",
        }),
      ).toThrow(
        /Missing preserved signing artifacts: nemoclaw-user-get-started\/skill\.oms\.sig/,
      );
    } finally {
      cleanup();
    }
  });
});
