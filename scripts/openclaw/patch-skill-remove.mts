// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw: native workspace skill removal (#10210) */";
export const SUPPORTED_OPENCLAW_VERSION = "2026.7.1";
const LEGACY_FIXTURE_OPENCLAW_VERSIONS = new Set(["2026.3.11", "2026.4.24"]);
const TARGET_SIGNATURE =
  'skills.command("install").description("Install a skill from ClawHub, git, or a local directory")';
const HELPER_ANCHOR = "/**\n* Register the skills CLI commands\n*/";
const COMMAND_ANCHOR =
  '\tskills.command("update").description("Update ClawHub-installed skills in the active or shared managed directory")';
const REQUIRED_BINDINGS = [
  "validateRequestedSkillSlug",
  "loadSkillsStatusReport",
  "resolveSkillStatusEntry",
  "untrackClawHubSkill",
  "resolveAgentOption",
  "sanitizeForLog",
  "defaultRuntime",
] as const;

export const INJECTED_REMOVE_HELPER = [
  MARKER,
  "async function nemoClawRemoveWorkspaceSkillFromAgentState(name, agentId) {",
  "\tconst slug = validateRequestedSkillSlug(name);",
  "\tconst report = await loadSkillsStatusReport({ agentId });",
  "\tconst selected = resolveSkillStatusEntry(report.skills, slug);",
  "\tif (!selected) {",
  "\t\tawait untrackClawHubSkill(report.workspaceDir, slug);",
  '\t\treturn { status: "absent", slug };',
  "\t}",
  '\tconst filePath = typeof selected.filePath === "string" ? selected.filePath : "";',
  '\tconst skillsDir = path.join(report.workspaceDir, "skills");',
  "\tconst targetDir = path.join(skillsDir, slug);",
  "\tif (path.resolve(path.dirname(filePath)) !== path.resolve(targetDir)) {",
  '\t\treturn { status: "unmanaged", slug, source: selected.source, filePath };',
  "\t}",
  "\tlet targetStat;",
  "\tlet skillsRealPath;",
  "\tlet targetRealPath;",
  "\ttry {",
  "\t\ttargetStat = await fs.lstat(targetDir);",
  "\t\tskillsRealPath = await fs.realpath(skillsDir);",
  "\t\ttargetRealPath = await fs.realpath(targetDir);",
  "\t} catch (error) {",
  '\t\tif (error && typeof error === "object" && error.code === "ENOENT") {',
  "\t\t\tawait untrackClawHubSkill(report.workspaceDir, slug);",
  '\t\t\treturn { status: "absent", slug };',
  "\t\t}",
  "\t\tthrow error;",
  "\t}",
  "\tif (!targetStat.isDirectory() || targetStat.isSymbolicLink() || path.dirname(targetRealPath) !== skillsRealPath || path.basename(targetRealPath) !== slug) {",
  '\t\tthrow new Error("Refusing to remove a skill outside the active workspace skill boundary.");',
  "\t}",
  "\tconst quarantineDir = await fs.mkdtemp(path.join(skillsDir, `.${slug}.remove.`));",
  "\tconst quarantineTarget = path.join(quarantineDir, slug);",
  "\ttry {",
  "\t\tawait fs.rename(targetDir, quarantineTarget);",
  "\t\tconst movedStat = await fs.lstat(quarantineTarget);",
  "\t\tconst movedRealPath = await fs.realpath(quarantineTarget);",
  "\t\tconst quarantineRealPath = await fs.realpath(quarantineDir);",
  "\t\tif (!movedStat.isDirectory() || movedStat.isSymbolicLink() || movedStat.dev !== targetStat.dev || movedStat.ino !== targetStat.ino || path.dirname(movedRealPath) !== quarantineRealPath || path.basename(movedRealPath) !== slug) {",
  "\t\t\ttry { await fs.rename(quarantineTarget, targetDir); } catch {}",
  '\t\t\tthrow new Error("The active workspace skill changed during removal; no observed skill content was deleted.");',
  "\t\t}",
  "\t\tawait fs.rm(quarantineTarget, { recursive: true, force: false });",
  "\t} finally {",
  "\t\ttry { await fs.rmdir(quarantineDir); } catch {}",
  "\t}",
  "\tawait untrackClawHubSkill(report.workspaceDir, slug);",
  "\tconst after = await loadSkillsStatusReport({ agentId });",
  "\tconst active = resolveSkillStatusEntry(after.skills, slug);",
  '\treturn { status: "removed", slug, targetDir, active: active ? { source: active.source, filePath: active.filePath } : null };',
  "}",
  "",
].join("\n");

export const INJECTED_REMOVE_COMMAND = [
  '\tskills.command("remove").description("Remove a skill from the active agent workspace").argument("<name>", "Skill name").option("--json", "Output as JSON", false).option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)").action(async (name, opts, command) => {',
  "\t\ttry {",
  "\t\t\tconst result = await nemoClawRemoveWorkspaceSkillFromAgentState(name, resolveAgentOption(command, opts));",
  "\t\t\tif (opts.json) {",
  "\t\t\t\tdefaultRuntime.writeJson(result);",
  '\t\t\t\tif (result.status === "unmanaged" || result.active) defaultRuntime.exit(1);',
  "\t\t\t\treturn;",
  "\t\t\t}",
  '\t\t\tif (result.status === "unmanaged") {',
  '\t\t\t\tdefaultRuntime.error(`Skill "${sanitizeForLog(result.slug)}" is active from ${sanitizeForLog(result.source || "an unmanaged source")} at ${sanitizeForLog(result.filePath || "an unknown path")}; no workspace content was removed.`);',
  "\t\t\t\tdefaultRuntime.exit(1);",
  "\t\t\t\treturn;",
  "\t\t\t}",
  '\t\t\tif (result.status === "absent") {',
  '\t\t\t\tdefaultRuntime.log(`Skill "${sanitizeForLog(result.slug)}" is not installed in the active workspace.`);',
  "\t\t\t\treturn;",
  "\t\t\t}",
  "\t\t\tdefaultRuntime.log(`Removed ${sanitizeForLog(result.slug)} from ${sanitizeForLog(result.targetDir)}`);",
  '\t\t\tif (result.active) { defaultRuntime.error(`A same-name skill remains active from ${sanitizeForLog(result.active.source || "another source")} at ${sanitizeForLog(result.active.filePath || "an unknown path")}.`); defaultRuntime.exit(1); }',
  "\t\t} catch (err) {",
  "\t\t\tdefaultRuntime.error(String(err));",
  "\t\t\tdefaultRuntime.exit(1);",
  "\t\t}",
  "\t});",
  "",
].join("\n");

type PatchStatus = "patched" | "already-patched";

/** Count exact non-overlapping copies of one reviewed generated-code anchor. */
function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

/** Prove every module-scope binding referenced by the injected code exists. */
function assertRequiredBindings(source: string, filePath: string): void {
  for (const binding of REQUIRED_BINDINGS) {
    if (!source.includes(binding)) {
      throw new Error(`${filePath}: reviewed skill remove binding ${binding} is missing`);
    }
  }
  if (!source.includes('from "node:fs/promises"') || !source.includes('from "node:path"')) {
    throw new Error(`${filePath}: skill remove patch requires promise-fs and path bindings`);
  }
}

/** Enumerate the reviewed dist's top-level generated JavaScript modules. */
function listJsFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Read the package version paired with an OpenClaw dist directory. */
function readOpenClawVersion(distDir: string): string {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`OpenClaw package metadata missing version at ${packageJsonPath}`);
  }
  return parsed.version;
}

/** Inject the reviewed native remove helper and command into one skills CLI module. */
export function patchSkillRemoveText(
  source: string,
  filePath: string,
): {
  status: PatchStatus;
  text: string;
} {
  assertRequiredBindings(source, filePath);
  if (source.includes(MARKER)) {
    for (const required of [MARKER, INJECTED_REMOVE_COMMAND]) {
      if (countOccurrences(source, required) !== 1) {
        throw new Error(`${filePath}: skill remove patch is partial or ambiguous`);
      }
    }
    return { status: "already-patched", text: source };
  }
  for (const anchor of [TARGET_SIGNATURE, HELPER_ANCHOR, COMMAND_ANCHOR]) {
    if (countOccurrences(source, anchor) !== 1) {
      throw new Error(`${filePath}: expected exactly one reviewed skill remove anchor`);
    }
  }
  const text = source
    .replace(HELPER_ANCHOR, `${INJECTED_REMOVE_HELPER}${HELPER_ANCHOR}`)
    .replace(COMMAND_ANCHOR, `${INJECTED_REMOVE_COMMAND}${COMMAND_ANCHOR}`);
  if (
    countOccurrences(text, MARKER) !== 1 ||
    countOccurrences(text, INJECTED_REMOVE_COMMAND) !== 1
  ) {
    throw new Error(`${filePath}: skill remove patch verification failed`);
  }
  return { status: "patched", text };
}

/** Resolve the one generated skills CLI module in the reviewed dist. */
function resolveTarget(distDir: string): string {
  const targets = listJsFiles(distDir).filter((file) =>
    fs.readFileSync(file, "utf8").includes(TARGET_SIGNATURE),
  );
  if (targets.length !== 1) {
    throw new Error(`Expected exactly one OpenClaw skills CLI module, found ${targets.length}`);
  }
  return targets[0];
}

/** Apply the native remove capability only to the pinned reviewed OpenClaw version. */
export function patchOpenClawSkillRemove(distDir: string): {
  status: PatchStatus | "skipped-unsupported-version";
  version: string;
  file?: string;
} {
  const resolved = path.resolve(distDir);
  const version = readOpenClawVersion(resolved);
  if (version !== SUPPORTED_OPENCLAW_VERSION) {
    if (LEGACY_FIXTURE_OPENCLAW_VERSIONS.has(version)) {
      return { status: "skipped-unsupported-version", version };
    }
    throw new Error(`OpenClaw ${version} is not reviewed for native skill removal`);
  }
  const file = resolveTarget(resolved);
  const result = patchSkillRemoveText(fs.readFileSync(file, "utf8"), file);
  if (result.status === "patched") fs.writeFileSync(file, result.text);
  return { status: result.status, version, file };
}

/** Run patch or audit mode for a supplied OpenClaw dist directory. */
function main(argv: readonly string[]): number {
  const audit = argv[2] === "--audit";
  const distDir = audit ? argv[3] : argv[2];
  if (!distDir || argv.length !== (audit ? 4 : 3)) {
    console.error("Usage: patch-skill-remove.mts [--audit] <openclaw-dist-dir>");
    return 2;
  }
  try {
    const result = patchOpenClawSkillRemove(distDir);
    if (audit && result.status !== "already-patched") {
      throw new Error("native skill removal patch is not applied");
    }
    console.log(`INFO: OpenClaw native skill removal ${result.status} (${result.version})`);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  process.exitCode = main(process.argv);
}
