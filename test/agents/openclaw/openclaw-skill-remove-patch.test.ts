// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  INJECTED_REMOVE_COMMAND,
  MARKER,
  patchOpenClawSkillRemove,
  patchSkillRemoveText,
} from "../../../scripts/openclaw/patch-skill-remove.mts";

const roots: string[] = [];
const SOURCE = [
  'skills.command("install").description("Install a skill from ClawHub, git, or a local directory")',
  "/**",
  "* Register the skills CLI commands",
  "*/",
  "function registerSkillsCli(program) {",
  '\tskills.command("update").description("Update ClawHub-installed skills in the active or shared managed directory")',
  "}",
].join("\n");

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("OpenClaw native skill remove patch", () => {
  it("adds one idempotent native remove command", () => {
    const first = patchSkillRemoveText(SOURCE, "skills-cli.js");
    expect(first.status).toBe("patched");
    expect(first.text).toContain(MARKER);
    expect(first.text).toContain(INJECTED_REMOVE_COMMAND);
    expect(first.text).toContain("loadSkillsStatusReport({ agentId })");
    expect(first.text).toContain("untrackClawHubSkill(report.workspaceDir, slug)");
    expect(first.text).toContain("await fs.rename(targetDir, quarantineTarget)");
    expect(first.text).toContain("movedStat.ino !== targetStat.ino");

    expect(patchSkillRemoveText(first.text, "skills-cli.js")).toEqual({
      status: "already-patched",
      text: first.text,
    });
  });

  it("rejects a changed or ambiguous upstream command boundary", () => {
    expect(() =>
      patchSkillRemoveText(
        SOURCE.replace('skills.command("update")', 'skills.command("upgrade")'),
        "skills-cli.js",
      ),
    ).toThrow("expected exactly one reviewed skill remove anchor");
    expect(() => patchSkillRemoveText(`${SOURCE}\n${SOURCE}`, "skills-cli.js")).toThrow(
      "expected exactly one reviewed skill remove anchor",
    );
  });

  it("patches only the reviewed OpenClaw version", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-patch-"));
    roots.push(packageRoot);
    const dist = path.join(packageRoot, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"2026.7.1"}\n');
    fs.writeFileSync(path.join(dist, "skills-cli.js"), SOURCE);

    expect(patchOpenClawSkillRemove(dist)).toMatchObject({
      status: "patched",
      version: "2026.7.1",
    });
    expect(fs.readFileSync(path.join(dist, "skills-cli.js"), "utf8")).toContain(MARKER);

    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"2026.9.1"}\n');
    expect(() => patchOpenClawSkillRemove(dist)).toThrow(
      "OpenClaw 2026.9.1 is not reviewed for native skill removal",
    );
  });

  it("removes only the skill selected from native workspace state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-behavior-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const targetDir = path.join(workspaceDir, "skills", "demo-skill");
    const filePath = path.join(targetDir, "SKILL.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, "---\nname: demo-skill\n---\n");

    const behaviorSource = [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      "const chain = { description() { return this; }, argument() { return this; }, option() { return this; }, action() { return this; } };",
      "const skills = { command() { return chain; } };",
      "let reports = [];",
      "const untracked = [];",
      "async function loadSkillsStatusReport() { return reports.shift(); }",
      "function validateRequestedSkillSlug(value) { return value; }",
      "function resolveSkillStatusEntry(skills, value) { return skills.find((entry) => entry.name === value || entry.skillKey === value) ?? null; }",
      "async function untrackClawHubSkill(workspace, slug) { untracked.push([workspace, slug]); }",
      "function configure(nextReports) { reports = nextReports.slice(); }",
      SOURCE,
      "export { configure, nemoClawRemoveWorkspaceSkillFromAgentState, untracked };",
    ].join("\n");
    const patched = patchSkillRemoveText(behaviorSource, "behavior.mjs");
    const modulePath = path.join(root, "behavior.mjs");
    fs.writeFileSync(modulePath, patched.text);
    const behavior = (await import(
      `${pathToFileURL(modulePath).href}?case=${String(Date.now())}`
    )) as {
      configure: (reports: unknown[]) => void;
      nemoClawRemoveWorkspaceSkillFromAgentState: (
        name: string,
        agentId: string,
      ) => Promise<Record<string, unknown>>;
      untracked: Array<[string, string]>;
    };
    behavior.configure([
      {
        workspaceDir,
        skills: [
          {
            name: "demo-skill",
            skillKey: "demo-skill",
            source: "openclaw-workspace",
            filePath,
          },
        ],
      },
      { workspaceDir, skills: [] },
    ]);

    await expect(
      behavior.nemoClawRemoveWorkspaceSkillFromAgentState("demo-skill", "main"),
    ).resolves.toMatchObject({
      status: "removed",
      slug: "demo-skill",
      targetDir,
      active: null,
    });
    expect(fs.existsSync(targetDir)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(workspaceDir, "skills"))
        .filter((entry) => entry.startsWith(".demo-skill.remove.")),
    ).toEqual([]);
    expect(behavior.untracked).toEqual([[workspaceDir, "demo-skill"]]);
  });

  it("refuses a same-name skill selected from outside the native workspace target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-unmanaged-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const managedDir = path.join(root, "managed", "demo-skill");
    const filePath = path.join(managedDir, "SKILL.md");
    fs.mkdirSync(managedDir, { recursive: true });
    fs.writeFileSync(filePath, "---\nname: demo-skill\n---\n");

    const behaviorSource = [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      "const chain = { description() { return this; }, argument() { return this; }, option() { return this; }, action() { return this; } };",
      "const skills = { command() { return chain; } };",
      `const report = ${JSON.stringify({
        workspaceDir,
        skills: [
          {
            name: "demo-skill",
            skillKey: "demo-skill",
            source: "openclaw-managed",
            filePath,
          },
        ],
      })};`,
      "async function loadSkillsStatusReport() { return report; }",
      "function validateRequestedSkillSlug(value) { return value; }",
      "function resolveSkillStatusEntry(skills, value) { return skills.find((entry) => entry.name === value || entry.skillKey === value) ?? null; }",
      "async function untrackClawHubSkill() { throw new Error('must not untrack unmanaged state'); }",
      SOURCE,
      "export { nemoClawRemoveWorkspaceSkillFromAgentState };",
    ].join("\n");
    const patched = patchSkillRemoveText(behaviorSource, "behavior-unmanaged.mjs");
    const modulePath = path.join(root, "behavior-unmanaged.mjs");
    fs.writeFileSync(modulePath, patched.text);
    const behavior = (await import(
      `${pathToFileURL(modulePath).href}?case=${String(Date.now())}`
    )) as {
      nemoClawRemoveWorkspaceSkillFromAgentState: (
        name: string,
        agentId: string,
      ) => Promise<Record<string, unknown>>;
    };

    await expect(
      behavior.nemoClawRemoveWorkspaceSkillFromAgentState("demo-skill", "main"),
    ).resolves.toMatchObject({
      status: "unmanaged",
      slug: "demo-skill",
      source: "openclaw-managed",
      filePath,
    });
    expect(fs.existsSync(managedDir)).toBe(true);
  });
});
