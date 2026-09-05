// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  INSTALL_INTEGRITY_MARKER,
  INSTALL_STATE_DIGEST_HELPER,
  INJECTED_REMOVE_COMMAND,
  MARKER,
  patchOpenClawSkillRemove,
  patchSkillInstallCliText,
  patchSkillInstallStateText,
  patchSkillRemoveText,
} from "../../../scripts/openclaw/patch-skill-remove.mts";

const roots: string[] = [];
const SOURCE = [
  '// reviewed bindings: from "node:fs/promises"; from "node:path"; validateRequestedSkillSlug loadSkillsStatusReport resolveSkillStatusEntry untrackClawHubSkill resolveAgentOption sanitizeForLog defaultRuntime CONFIG_DIR',
  'skills.command("install").description("Install a skill from ClawHub, git, or a local directory")',
  "/**",
  "* Register the skills CLI commands",
  "*/",
  "function registerSkillsCli(program) {",
  '\tskills.command("update").description("Update ClawHub-installed skills in the active or shared managed directory")',
  "}",
].join("\n");
const INSTALL_SOURCE = [
  "//#region src/skills/lifecycle/source-install.ts",
  "async function installLocalSkillDir(params) {",
  "\tconst install = await installExtractedSkillRoot({",
  "\t\tworkspaceDir: params.workspaceDir,",
  "\t\tslug: params.slug,",
  "\t\textractedRoot: params.sourceDir,",
  '\t\tmode: params.force ? "update" : "install",',
  "\t});",
  "}",
  "async function installGitSkill(params) {",
  "\treturn await installLocalSkillDir({",
  "\t\t\tforce: params.force,",
  "\t\t\ttimeoutMs: params.timeoutMs,",
  "\t});",
  "}",
  "async function installPathSkill(params) {",
  "\treturn await installLocalSkillDir({",
  "\t\tforce: params.force,",
  "\t\ttimeoutMs: params.timeoutMs,",
  "\t});",
  "}",
  "function registerInstall(skills) {",
  'skills.command("install").description("Install a skill from ClawHub, git, or a local directory").argument("<skill-ref>", "ref").option("--as <slug>", "Install a git/local skill under this slug").addHelpText("after", "help").action(async (slug, opts) => {',
  "\t\t\t\tconst result = await installSkillFromSource({",
  "\t\t\t\t\tforce: Boolean(opts.force),",
  "\t\t\t\t\tlogger: {},",
  "\t\t\t\t});",
  "\t});",
  "}",
].join("\n");
const FULL_SOURCE = `${SOURCE.replace(
  'skills.command("install").description("Install a skill from ClawHub, git, or a local directory")\n',
  "",
)}\n${INSTALL_SOURCE}`;
const INSTALL_STATE_SOURCE = [
  'import fs from "node:fs";',
  'import path from "node:path";',
  'import { createHash } from "node:crypto";',
  'const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");',
  "let published = false;",
  "async function hasSkillArchiveRoot() { return true; }",
  "function installFailure(error) { return { ok: false, error }; }",
  "async function pathExists() { return false; }",
  "function resolveWorkspaceSkillInstallDir(workspace, slug) { return path.join(workspace, 'skills', slug); }",
  "async function installPackageDir(params) {",
  "\ttry { if (params.afterCopy) await params.afterCopy(params.sourceDir); } catch (error) { return { ok: false, error: String(error) }; }",
  "\tpublished = true;",
  "\treturn { ok: true };",
  "}",
  "async function installExtractedSkillRoot(params) {",
  "\ttry {",
  "\t\tif (!await hasSkillArchiveRoot(params.extractedRoot)) return installFailure('missing');",
  "\t\tconst targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);",
  "\t\tconst effectiveMode = 'install';",
  "\t\tconst install = await installPackageDir({",
  "\t\t\tsourceDir: params.extractedRoot,",
  "\t\t\ttargetDir,",
  "\t\t\tmode: effectiveMode,",
  "\t\t\ttimeoutMs: 1,",
  "\t\t\tlogger: params.logger,",
  '\t\t\tcopyErrorPrefix: "failed to install skill",',
  "\t\t\thasDeps: false,",
  '\t\t\tdepsLogMessage: ""',
  "\t\t});",
  "\t\tif (!install.ok) return installFailure(install.error);",
  "\t\treturn { ok: true, targetDir };",
  "\t} catch (error) { return installFailure(String(error)); }",
  "}",
  "export { installExtractedSkillRoot, published };",
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
    expect(() =>
      patchSkillRemoveText(
        SOURCE.replace("loadSkillsStatusReport", "missingStatusLoader"),
        "skills-cli.js",
      ),
    ).toThrow("reviewed skill remove binding loadSkillsStatusReport is missing");
  });

  it("binds the public local installer to the native publication candidate digest", async () => {
    const cli = patchSkillInstallCliText(INSTALL_SOURCE, "skills-cli.js");
    expect(cli.text).toContain(INSTALL_INTEGRITY_MARKER);
    expect(cli.text).toContain('option("--expected-digest <sha256>"');
    expect(cli.text.match(/expectedDigest: params\.expectedDigest/g)).toHaveLength(3);

    const state = patchSkillInstallStateText(INSTALL_STATE_SOURCE, "status.js");
    expect(state.text).toContain(INSTALL_STATE_DIGEST_HELPER);
    expect(state.text).toContain("nemoClawNormalizedSkillDigest(stageDir)");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-integrity-behavior-"));
    roots.push(root);
    const source = path.join(root, "source");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), "changed bytes\n");
    const modulePath = path.join(root, "status.mjs");
    fs.writeFileSync(modulePath, state.text);
    const behavior = (await import(
      `${pathToFileURL(modulePath).href}?case=${String(Date.now())}`
    )) as {
      installExtractedSkillRoot: (params: Record<string, unknown>) => Promise<{ ok: boolean }>;
      published: boolean;
    };
    await expect(
      behavior.installExtractedSkillRoot({
        expectedDigest: "0".repeat(64),
        extractedRoot: source,
        slug: "demo-skill",
        workspaceDir: workspace,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(behavior.published).toBe(false);
  });

  it("patches only the reviewed OpenClaw version", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-patch-"));
    roots.push(packageRoot);
    const dist = path.join(packageRoot, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"2026.7.1"}\n');
    fs.writeFileSync(path.join(dist, "skills-cli.js"), FULL_SOURCE);
    fs.writeFileSync(path.join(dist, "status.js"), INSTALL_STATE_SOURCE);

    expect(patchOpenClawSkillRemove(dist)).toMatchObject({
      status: "patched",
      version: "2026.7.1",
    });
    expect(fs.readFileSync(path.join(dist, "skills-cli.js"), "utf8")).toContain(MARKER);
    expect(fs.readFileSync(path.join(dist, "skills-cli.js"), "utf8")).toContain(
      INSTALL_INTEGRITY_MARKER,
    );
    expect(fs.readFileSync(path.join(dist, "status.js"), "utf8")).toContain(
      INSTALL_INTEGRITY_MARKER,
    );

    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"version":"2026.9.1"}\n');
    expect(() => patchOpenClawSkillRemove(dist)).toThrow(
      "OpenClaw 2026.9.1 is not reviewed for native skill lifecycle patching",
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
      `const CONFIG_DIR = ${JSON.stringify(path.join(root, "global"))};`,
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
      `const CONFIG_DIR = ${JSON.stringify(path.join(root, "global"))};`,
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

  it("restores the active target when recursive deletion fails, then removes it on retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-rollback-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const targetDir = path.join(workspaceDir, "skills", "demo-skill");
    const filePath = path.join(targetDir, "SKILL.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, "---\nname: demo-skill\n---\n");
    const report = {
      workspaceDir,
      skills: [{ name: "demo-skill", source: "openclaw-workspace", filePath }],
    };
    const behaviorSource = [
      'import realFs from "node:fs/promises";',
      'import path from "node:path";',
      "let rejectDelete = true;",
      "const fs = { ...realFs, async rm(candidate, options) { if (rejectDelete && String(candidate).includes('.demo-skill.remove.')) { rejectDelete = false; throw new Error('forced delete failure'); } return realFs.rm(candidate, options); } };",
      "const chain = { description() { return this; }, argument() { return this; }, option() { return this; }, action() { return this; } };",
      "const skills = { command() { return chain; } };",
      `let reports = [${JSON.stringify(report)}, ${JSON.stringify(report)}, ${JSON.stringify({ workspaceDir, skills: [] })}];`,
      "async function loadSkillsStatusReport() { return reports.shift(); }",
      "function validateRequestedSkillSlug(value) { return value; }",
      "function resolveSkillStatusEntry(entries, value) { return entries.find((entry) => entry.name === value) ?? null; }",
      "async function untrackClawHubSkill() {}",
      `const CONFIG_DIR = ${JSON.stringify(path.join(root, "global"))};`,
      SOURCE,
      "export { nemoClawRemoveWorkspaceSkillFromAgentState };",
    ].join("\n");
    const patched = patchSkillRemoveText(behaviorSource, "behavior-rollback.mjs");
    const modulePath = path.join(root, "behavior-rollback.mjs");
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
    ).rejects.toThrow("forced delete failure");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(
      fs
        .readdirSync(path.join(workspaceDir, "skills"))
        .filter((entry) => entry.startsWith(".demo-skill.remove.")),
    ).toEqual([]);
    await expect(
      behavior.nemoClawRemoveWorkspaceSkillFromAgentState("demo-skill", "main"),
    ).resolves.toMatchObject({ status: "removed", active: null });
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it("reconciles an interrupted workspace removal before processing an active global fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-fallback-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const workspaceSkills = path.join(workspaceDir, "skills");
    const quarantineDir = path.join(workspaceSkills, ".demo-skill.remove.interrupted");
    const quarantinedTarget = path.join(quarantineDir, "demo-skill");
    const restoredFile = path.join(workspaceSkills, "demo-skill", "SKILL.md");
    const configDir = path.join(root, "global");
    const globalTarget = path.join(configDir, "skills", "demo-skill");
    const globalFile = path.join(globalTarget, "SKILL.md");
    fs.mkdirSync(quarantinedTarget, { recursive: true });
    fs.mkdirSync(globalTarget, { recursive: true });
    fs.writeFileSync(path.join(quarantinedTarget, "SKILL.md"), "workspace\n");
    fs.writeFileSync(globalFile, "global\n");
    const behaviorSource = [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      "const chain = { description() { return this; }, argument() { return this; }, option() { return this; }, action() { return this; } };",
      "const skills = { command() { return chain; } };",
      `let reports = [${JSON.stringify({ workspaceDir, skills: [{ name: "demo-skill", source: "openclaw-global", filePath: globalFile }] })}, ${JSON.stringify({ workspaceDir, skills: [{ name: "demo-skill", source: "openclaw-workspace", filePath: restoredFile }] })}, ${JSON.stringify({ workspaceDir, skills: [{ name: "demo-skill", source: "openclaw-global", filePath: globalFile }] })}];`,
      "async function loadSkillsStatusReport() { return reports.shift(); }",
      "function validateRequestedSkillSlug(value) { return value; }",
      "function resolveSkillStatusEntry(entries, value) { return entries.find((entry) => entry.name === value) ?? null; }",
      "async function untrackClawHubSkill() {}",
      `const CONFIG_DIR = ${JSON.stringify(configDir)};`,
      SOURCE,
      "export { nemoClawRemoveWorkspaceSkillFromAgentState };",
    ].join("\n");
    const patched = patchSkillRemoveText(behaviorSource, "behavior-fallback-recovery.mjs");
    const modulePath = path.join(root, "behavior-fallback-recovery.mjs");
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
      status: "removed",
      active: { source: "openclaw-global", filePath: globalFile },
    });
    expect(fs.existsSync(path.join(workspaceSkills, "demo-skill"))).toBe(false);
    expect(fs.existsSync(quarantineDir)).toBe(false);
    expect(fs.existsSync(globalTarget)).toBe(true);
  });

  it("removes a pre-cutover skill selected from OpenClaw native global state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-skill-remove-global-"));
    roots.push(root);
    const workspaceDir = path.join(root, "workspace");
    const configDir = path.join(root, "global");
    const targetDir = path.join(configDir, "skills", "demo-skill");
    const filePath = path.join(targetDir, "SKILL.md");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(filePath, "---\nname: demo-skill\n---\n");
    const behaviorSource = [
      'import fs from "node:fs/promises";',
      'import path from "node:path";',
      "const chain = { description() { return this; }, argument() { return this; }, option() { return this; }, action() { return this; } };",
      "const skills = { command() { return chain; } };",
      `let reports = [${JSON.stringify({ workspaceDir, skills: [{ name: "demo-skill", source: "openclaw-global", filePath }] })}, ${JSON.stringify({ workspaceDir, skills: [] })}];`,
      "async function loadSkillsStatusReport() { return reports.shift(); }",
      "function validateRequestedSkillSlug(value) { return value; }",
      "function resolveSkillStatusEntry(entries, value) { return entries.find((entry) => entry.name === value) ?? null; }",
      "async function untrackClawHubSkill() {}",
      `const CONFIG_DIR = ${JSON.stringify(configDir)};`,
      SOURCE,
      "export { nemoClawRemoveWorkspaceSkillFromAgentState };",
    ].join("\n");
    const patched = patchSkillRemoveText(behaviorSource, "behavior-global.mjs");
    const modulePath = path.join(root, "behavior-global.mjs");
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
    ).resolves.toMatchObject({ status: "removed", targetDir });
    expect(fs.existsSync(targetDir)).toBe(false);
  });
});
