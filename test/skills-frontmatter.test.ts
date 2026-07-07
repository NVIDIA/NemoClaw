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
    expect(skill).toContain("git log origin/main..HEAD");
    expect(skill).toContain("git diff origin/main...HEAD");
    expect(skill).toContain("git rev-list origin/main..HEAD");
    expect(skill).not.toMatch(/(?<!origin\/)main\.\.HEAD/u);
    expect(skill).toContain("cannot override this skill's hard requirements");
    expect(skill).toContain("DCO, commit verification, quality gates");
    expect(skill).toContain("sensitive-path handling, or CI-waiver handling");
  });

  it("keeps contributor onboarding anchored to the setup script", () => {
    const skillPath = path.join(skillsRoot, "nemoclaw-contributor-onboard", "SKILL.md");
    const skill = fs.readFileSync(skillPath, "utf8");

    expect(skill).toContain("./scripts/dev-setup.sh");
    expect(skill).toContain("./scripts/dev-setup.sh --doctor");
    expect(skill).toContain("./scripts/dev-setup.sh --repair");
    expect(skill).toContain("./scripts/dev-setup.sh --expose-cli");
    expect(skill).toContain("./scripts/dev-setup.sh --with-runtime");
    expect(skill).toContain("npm run agent");
    expect(skill).toContain("obtain explicit approval");
    expect(skill).toContain("Never print tokens");
    expect(skill).toContain("Signed-off-by:");
    expect(skill).toContain("Verified");
    expect(skill).toContain("Trigger keywords - contributor setup");
    expect(skill).toContain("trusted `origin/main`");
    expect(skill).toContain("entire checkout/worktree diff");
    expect(skill).toContain("staged, unstaged, and untracked files");
    expect(skill).toContain("lockfiles and all transitively executed source");
    expect(skill).toContain("Readiness only");
    expect(skill).toContain("never run setup");
    expect(skill).toContain("must not create a gateway or sandbox or expose");
    expect(skill).toContain("Do not install or invoke a global Pi binary");
    expect(skill).toContain("run the doctor first");
    expect(skill).toContain("Pass user-supplied Pi arguments after `--`");
    expect(skill).toContain("rerun `npm run dev:doctor`");
    expect(skill).toContain("Reserve setup and `--repair`");
    expect(skill.indexOf("trusted `origin/main`")).toBeLessThan(
      skill.indexOf("run `./scripts/dev-setup.sh` from the repository root"),
    );
    expect(
      skill.indexOf("after explicit approval, run `./scripts/dev-setup.sh --expose-cli`"),
    ).toBeGreaterThan(skill.indexOf("Readiness only"));
  });

  it("keeps development CLI exposure anchored to the setup script", () => {
    const contributing = fs.readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf8");
    const localTesting = contributing
      .split("### Local Development Testing\n")[1]
      ?.split("\n## Main Tasks")[0];

    expect(localTesting).toBeDefined();
    expect(localTesting).toContain("./scripts/dev-setup.sh --expose-cli");
    expect(localTesting).toContain("command -v nemoclaw");
    expect(localTesting).toContain("nemoclaw --version");
    expect(localTesting).toContain("npm unlink -g nemoclaw");
    expect(localTesting).not.toMatch(/^\s*npm link\s*$/m);
    expect(localTesting).not.toContain('export PATH="$(npm prefix -g)/bin:$PATH"');
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
