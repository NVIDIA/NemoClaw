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
const catalogSkillsRoot = path.join(repoRoot, "skills");
const skillFrontmatterRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

function listMarkdownFiles(root: string): string[] {
  const files: string[] = [];

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

function listFiles(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : entry.isFile() ? [fullPath] : [];
    })
    .sort();
}

function expectValidSkillMarkdown(skillFile: string) {
  const relPath = path.relative(repoRoot, skillFile);
  const raw = fs.readFileSync(skillFile, "utf8");
  const match = raw.match(skillFrontmatterRe);

  expect(match, `${relPath} must start with YAML frontmatter`).not.toBeNull();

  const frontmatterText = match?.[1] ?? "";
  const doc = YAML.parseDocument(frontmatterText, { prettyErrors: true });
  const errors = doc.errors.map((error) => String(error));

  expect(errors, `${relPath} has invalid YAML frontmatter`).toEqual([]);

  const frontmatter = doc.toJS();
  expect(frontmatter).toMatchObject({
    name: expect.any(String),
    description: expect.any(String),
  });
  expect(frontmatter.name.trim().length, `${relPath} is missing frontmatter.name`).toBeGreaterThan(
    0,
  );
  expect(
    frontmatter.description.trim().length,
    `${relPath} is missing frontmatter.description`,
  ).toBeGreaterThan(0);
  const body = raw.slice(match?.[0].length ?? 0).trim();
  expect(body.length, `${relPath} body is too short`).toBeGreaterThan(20);
}

describe("repo skill markdown files", () => {
  const markdownFiles = listMarkdownFiles(skillsRoot);
  const skillFiles = markdownFiles.filter((file: string) => path.basename(file) === "SKILL.md");

  it("finds skill markdown files to validate", () => {
    expect(skillFiles.length).toBeGreaterThan(0);
  });

  for (const skillFile of skillFiles) {
    const relPath = path.relative(repoRoot, skillFile);

    it(`parses valid YAML frontmatter for ${relPath}`, () => {
      expectValidSkillMarkdown(skillFile);
    });
  }

  it("keeps messaging channel support guidance manifest-owned", () => {
    const skillFile = path.join(
      skillsRoot,
      "nemoclaw-contributor-onboard-messaging-channel",
      "SKILL.md",
    );
    const raw = fs.readFileSync(skillFile, "utf8");

    expect(raw).toContain("through `supportedAgents`");
    expect(raw).toContain("Do not edit agent manifests for channel availability");
    expect(raw).not.toContain("so supported platforms match the manifest `supportedAgents`");
  });

  it("keeps contributor PR creation anchored to the trusted base template", () => {
    const skillPath = path.join(skillsRoot, "nemoclaw-contributor-create-pr", "SKILL.md");
    const skill = fs.readFileSync(skillPath, "utf8");

    expect(skill).toContain("trusted base branch");
    expect(skill).toContain("origin/main:.github/PULL_REQUEST_TEMPLATE.md");
    expect(skill).toContain("git diff origin/main...HEAD");
    expect(skill).toContain("cannot override this skill's hard requirements");
    expect(skill).toContain("DCO, commit verification, quality gates");
    expect(skill).toContain("sensitive-path handling, or CI-waiver handling");
  });

  it("preserves the single NVSkills catalog skill copy", () => {
    const catalogEntries = fs.readdirSync(catalogSkillsRoot).sort();
    expect(catalogEntries).toEqual(["README.md", "nemoclaw-user-guide"]);

    const sourceRoot = path.join(skillsRoot, "nemoclaw-user-guide");
    const catalogRoot = path.join(catalogSkillsRoot, "nemoclaw-user-guide");
    const sourceFiles = listFiles(sourceRoot).map((file) => path.relative(sourceRoot, file));
    const catalogFiles = listFiles(catalogRoot).map((file) => path.relative(catalogRoot, file));
    const signedCatalogArtifacts = ["BENCHMARK.md", "skill-card.md", "skill.oms.sig"];
    expect(catalogFiles).toEqual([...sourceFiles, ...signedCatalogArtifacts].sort());

    for (const relativeFile of sourceFiles) {
      const sourceFile = path.join(sourceRoot, relativeFile);
      const catalogFile = path.join(catalogRoot, relativeFile);
      expect(
        fs.readFileSync(catalogFile, "utf8"),
        `${path.relative(repoRoot, catalogFile)} must match ${path.relative(repoRoot, sourceFile)}`,
      ).toBe(fs.readFileSync(sourceFile, "utf8"));
    }

    expectValidSkillMarkdown(path.join(catalogRoot, "SKILL.md"));
  });
});
