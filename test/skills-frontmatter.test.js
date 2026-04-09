// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const skillsRoot = path.join(repoRoot, ".agents", "skills");
const frontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function listSkillFiles(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "SKILL.md"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

describe("repo skill frontmatter", () => {
  const skillFiles = listSkillFiles(skillsRoot);

  it("finds repo skills to validate", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  for (const skillFile of skillFiles) {
    const relPath = path.relative(repoRoot, skillFile);

    it(`parses valid YAML frontmatter for ${relPath}`, () => {
      const raw = fs.readFileSync(skillFile, "utf8");
      const match = raw.match(frontmatterRe);

      expect(match, `${relPath} is missing YAML frontmatter`).not.toBeNull();

      const frontmatterText = match[1];
      const doc = YAML.parseDocument(frontmatterText, { prettyErrors: true });
      const errors = doc.errors.map((error) => String(error));

      expect(errors, `${relPath} has invalid YAML frontmatter`).toEqual([]);

      const frontmatter = doc.toJS();
      expect(frontmatter).toMatchObject({
        name: expect.any(String),
        description: expect.any(String),
      });
      expect(
        frontmatter.name.trim().length,
        `${relPath} is missing frontmatter.name`,
      ).toBeGreaterThan(0);
      expect(
        frontmatter.description.trim().length,
        `${relPath} is missing frontmatter.description`,
      ).toBeGreaterThan(0);

      const body = raw.slice(match[0].length).trim();
      expect(body.length, `${relPath} body is too short`).toBeGreaterThan(20);
    });
  }
});
