// @ts-nocheck
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
const spdxHeader = [
  "<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->",
  "<!-- SPDX-License-Identifier: Apache-2.0 -->",
].join("\n");
// SKILL.md: frontmatter first, then SPDX after the closing ---
const skillFrontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function listMarkdownFiles(root) {
  const files = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

describe("repo skill markdown files", () => {
  const markdownFiles = listMarkdownFiles(skillsRoot);
  const generatedUserSkillFiles = markdownFiles.filter((file) =>
    path.relative(skillsRoot, file).startsWith("nemoclaw-user-"),
  );

  it("finds generated user skill markdown files to validate", () => {
    expect(generatedUserSkillFiles.length).toBeGreaterThan(0);
  });

  for (const markdownFile of generatedUserSkillFiles) {
    const relPath = path.relative(repoRoot, markdownFile);
    const isSkill = path.basename(markdownFile) === "SKILL.md";

    it(`includes SPDX header for ${relPath}`, () => {
      const raw = fs.readFileSync(markdownFile, "utf8");
      if (isSkill) {
        // SKILL.md: SPDX must appear after frontmatter (not before, to preserve markdownlint compatibility)
        expect(raw.includes(spdxHeader), `${relPath} is missing SPDX header`).toBe(true);
      } else {
        // Reference files: SPDX at the top
        expect(raw.startsWith(spdxHeader), `${relPath} is missing SPDX header at start`).toBe(true);
      }
    });
  }

  const skillFiles = generatedUserSkillFiles.filter((file) => path.basename(file) === "SKILL.md");

  for (const skillFile of skillFiles) {
    const relPath = path.relative(repoRoot, skillFile);

    it(`parses valid YAML frontmatter for ${relPath}`, () => {
      const raw = fs.readFileSync(skillFile, "utf8");
      const match = raw.match(skillFrontmatterRe);

      expect(match, `${relPath} must start with YAML frontmatter`).not.toBeNull();

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

      // SPDX must appear after frontmatter
      const afterFrontmatter = raw.slice(match[0].length);
      expect(
        afterFrontmatter.includes(spdxHeader),
        `${relPath} must include SPDX header after frontmatter`,
      ).toBe(true);

      const body = raw.slice(match[0].length).replace(spdxHeader, "").trim();
      expect(body.length, `${relPath} body is too short`).toBeGreaterThan(20);
    });
  }
});
