// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw: native workspace skill removal (#10210) */";
export const INSTALL_INTEGRITY_MARKER = "/* nemoclaw: native skill install integrity (#10210) */";
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
  "CONFIG_DIR",
] as const;

export const INJECTED_REMOVE_HELPER = [
  MARKER,
  "async function nemoClawRemoveWorkspaceSkillFromAgentState(name, agentId) {",
  "\tconst slug = validateRequestedSkillSlug(name);",
  "\tlet report = await loadSkillsStatusReport({ agentId });",
  '\tconst supportedTargets = [path.join(report.workspaceDir, "skills"), path.join(CONFIG_DIR, "skills")].map((skillsDir) => ({ skillsDir, targetDir: path.join(skillsDir, slug) }));',
  "\tlet selected = resolveSkillStatusEntry(report.skills, slug);",
  "\tif (!selected) {",
  "\t\tconst recoveries = [];",
  "\t\tfor (const target of supportedTargets) {",
  "\t\t\tlet entries;",
  '\t\t\ttry { entries = await fs.readdir(target.skillsDir, { withFileTypes: true }); } catch (error) { if (error && typeof error === "object" && error.code === "ENOENT") continue; throw error; }',
  "\t\t\tfor (const entry of entries) {",
  "\t\t\t\tif (!entry.isDirectory() || !entry.name.startsWith(`.${slug}.remove.`)) continue;",
  "\t\t\t\tconst candidate = path.join(target.skillsDir, entry.name, slug);",
  '\t\t\t\ttry { const stat = await fs.lstat(candidate); if (stat.isDirectory() && !stat.isSymbolicLink()) recoveries.push({ ...target, candidate, quarantineDir: path.dirname(candidate) }); } catch (error) { if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error; }',
  "\t\t\t}",
  "\t\t}",
  '\t\tif (recoveries.length > 1) throw new Error(`Multiple interrupted removals require inspection: ${recoveries.map((entry) => entry.candidate).join(", ")}`);',
  "\t\tif (recoveries.length === 1) {",
  "\t\t\tconst recovery = recoveries[0];",
  '\t\t\ttry { await fs.lstat(recovery.targetDir); throw new Error(`Cannot restore interrupted removal because ${recovery.targetDir} already exists; retained ${recovery.candidate}`); } catch (error) { if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error; }',
  "\t\t\tawait fs.rename(recovery.candidate, recovery.targetDir);",
  "\t\t\tawait fs.rmdir(recovery.quarantineDir);",
  "\t\t\treport = await loadSkillsStatusReport({ agentId });",
  "\t\t\tselected = resolveSkillStatusEntry(report.skills, slug);",
  "\t\t\tif (!selected) throw new Error(`Restored interrupted removal to ${recovery.targetDir}, but OpenClaw does not resolve it; inspect native skill state.`);",
  "\t\t}",
  "\t}",
  "\tif (!selected) {",
  "\t\tawait untrackClawHubSkill(report.workspaceDir, slug);",
  '\t\treturn { status: "absent", slug };',
  "\t}",
  '\tconst filePath = typeof selected.filePath === "string" ? selected.filePath : "";',
  "\tconst target = supportedTargets.find((entry) => path.resolve(path.dirname(filePath)) === path.resolve(entry.targetDir));",
  "\tif (!target) {",
  '\t\treturn { status: "unmanaged", slug, source: selected.source, filePath };',
  "\t}",
  "\tconst { skillsDir, targetDir } = target;",
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
  "\t\ttry {",
  "\t\t\tawait fs.rm(quarantineTarget, { recursive: true, force: false });",
  "\t\t} catch (error) {",
  "\t\t\ttry { await fs.rename(quarantineTarget, targetDir); } catch (restoreError) { throw new Error(`Skill removal failed and rollback failed; retained ${quarantineTarget}: ${String(restoreError)}`, { cause: error }); }",
  "\t\t\tthrow error;",
  "\t\t}",
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

const INSTALL_OPTION_ANCHOR =
  '.option("--as <slug>", "Install a git/local skill under this slug").addHelpText';
const INSTALL_ACTION_ANCHOR = "\t\t\t\t\tforce: Boolean(opts.force),\n\t\t\t\t\tlogger: {";
const INSTALL_LOCAL_CALL_ANCHOR =
  '\t\textractedRoot: params.sourceDir,\n\t\tmode: params.force ? "update" : "install",';
const INSTALL_SOURCE_FORWARD_ANCHOR = "\t\tforce: params.force,\n\t\ttimeoutMs: params.timeoutMs,";
const INSTALL_GIT_SOURCE_FORWARD_ANCHOR =
  "\t\t\tforce: params.force,\n\t\t\ttimeoutMs: params.timeoutMs,";

/** Bind the reviewed OpenClaw local-install command to a caller-supplied digest. */
export function patchSkillInstallCliText(
  source: string,
  filePath: string,
): { status: PatchStatus; text: string } {
  if (source.includes(INSTALL_INTEGRITY_MARKER)) {
    if (countOccurrences(source, INSTALL_INTEGRITY_MARKER) !== 1) {
      throw new Error(`${filePath}: skill install integrity patch is partial or ambiguous`);
    }
    return { status: "already-patched", text: source };
  }
  const expectedCounts = [
    [INSTALL_OPTION_ANCHOR, 1],
    [INSTALL_ACTION_ANCHOR, 1],
    [INSTALL_LOCAL_CALL_ANCHOR, 1],
    [INSTALL_SOURCE_FORWARD_ANCHOR, 1],
    [INSTALL_GIT_SOURCE_FORWARD_ANCHOR, 1],
  ] as const;
  for (const [anchor, expected] of expectedCounts) {
    if (countOccurrences(source, anchor) !== expected) {
      throw new Error(
        `${filePath}: expected ${expected} reviewed skill install integrity anchor(s)`,
      );
    }
  }
  const text = source
    .replace(
      INSTALL_OPTION_ANCHOR,
      `.option("--as <slug>", "Install a git/local skill under this slug").option("--expected-digest <sha256>", "Bind a local install to the expected normalized content digest").addHelpText`,
    )
    .replace(
      INSTALL_ACTION_ANCHOR,
      `\t\t\t\t\tforce: Boolean(opts.force),\n\t\t\t\t\texpectedDigest: opts.expectedDigest,\n\t\t\t\t\tlogger: {`,
    )
    .replace(
      INSTALL_LOCAL_CALL_ANCHOR,
      `\t\textractedRoot: params.sourceDir,\n\t\texpectedDigest: params.expectedDigest,\n\t\tmode: params.force ? "update" : "install",`,
    )
    .replace(
      INSTALL_SOURCE_FORWARD_ANCHOR,
      `\t\tforce: params.force,\n\t\texpectedDigest: params.expectedDigest,\n\t\ttimeoutMs: params.timeoutMs,`,
    )
    .replace(
      INSTALL_GIT_SOURCE_FORWARD_ANCHOR,
      `\t\t\tforce: params.force,\n\t\t\texpectedDigest: params.expectedDigest,\n\t\t\ttimeoutMs: params.timeoutMs,`,
    )
    .replace(
      "//#region src/skills/lifecycle/source-install.ts",
      `${INSTALL_INTEGRITY_MARKER}\n//#region src/skills/lifecycle/source-install.ts`,
    );
  if (
    countOccurrences(text, INSTALL_INTEGRITY_MARKER) !== 1 ||
    !text.includes('option("--expected-digest <sha256>"') ||
    countOccurrences(text, "expectedDigest: params.expectedDigest") !== 3
  ) {
    throw new Error(`${filePath}: skill install integrity patch verification failed`);
  }
  return { status: "patched", text };
}

const INSTALL_STATE_FUNCTION_ANCHOR = "async function installExtractedSkillRoot(params) {";
const INSTALL_STATE_COPY_ANCHOR =
  '\t\t\tcopyErrorPrefix: "failed to install skill",\n\t\t\thasDeps: false,';

export const INSTALL_STATE_DIGEST_HELPER = `${INSTALL_INTEGRITY_MARKER}
function nemoClawNormalizedSkillDigest(rootDir) {
\tconst files = [];
\tconst walk = (dir, prefix = "") => {
\t\tfor (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
\t\t\tconst relative = prefix ? prefix + "/" + entry.name : entry.name;
\t\t\tconst candidate = path.join(dir, entry.name);
\t\t\tif (entry.isSymbolicLink()) throw new Error("unsupported symbolic link: " + relative);
\t\t\tif (entry.isDirectory()) { walk(candidate, relative); continue; }
\t\t\tif (!entry.isFile()) throw new Error("unsupported skill path: " + relative);
\t\t\tconst descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
\t\t\ttry {
\t\t\t\tconst before = fs.fstatSync(descriptor);
\t\t\t\tif (!before.isFile()) throw new Error("skill path changed while reading: " + relative);
\t\t\t\tconst content = fs.readFileSync(descriptor);
\t\t\t\tconst after = fs.lstatSync(candidate);
\t\t\t\tif (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("skill path changed while reading: " + relative);
\t\t\t\tfiles.push({ relative, mode: before.mode & 73 ? "755" : "644", digest: sha256Hex(content) });
\t\t\t} finally { fs.closeSync(descriptor); }
\t\t}
\t};
\twalk(rootDir);
\treturn sha256Hex(files.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0).map((entry) => entry.mode + " " + entry.digest + "  " + entry.relative + "\\n").join(""));
}
`;

/** Verify the exact native publication candidate before OpenClaw swaps targets. */
export function patchSkillInstallStateText(
  source: string,
  filePath: string,
): { status: PatchStatus; text: string } {
  if (source.includes(INSTALL_INTEGRITY_MARKER)) {
    if (
      countOccurrences(source, INSTALL_INTEGRITY_MARKER) !== 1 ||
      !source.includes("nemoClawNormalizedSkillDigest(stageDir)")
    ) {
      throw new Error(`${filePath}: skill install state integrity patch is partial`);
    }
    return { status: "already-patched", text: source };
  }
  for (const anchor of [INSTALL_STATE_FUNCTION_ANCHOR, INSTALL_STATE_COPY_ANCHOR]) {
    if (countOccurrences(source, anchor) !== 1) {
      throw new Error(`${filePath}: expected one reviewed skill install state anchor`);
    }
  }
  if (
    !source.includes('import fs from "node:fs";') ||
    !source.includes('import path from "node:path";') ||
    !source.includes("sha256Hex")
  ) {
    throw new Error(`${filePath}: required skill install state bindings are missing`);
  }
  const text = source
    .replace(
      INSTALL_STATE_FUNCTION_ANCHOR,
      `${INSTALL_STATE_DIGEST_HELPER}${INSTALL_STATE_FUNCTION_ANCHOR}`,
    )
    .replace(
      INSTALL_STATE_COPY_ANCHOR,
      `\t\t\tcopyErrorPrefix: "failed to install skill",\n\t\t\tafterCopy: params.expectedDigest ? async (stageDir) => {\n\t\t\t\tif (!/^[0-9a-f]{64}$/.test(params.expectedDigest) || nemoClawNormalizedSkillDigest(stageDir) !== params.expectedDigest) throw new Error("staged skill digest changed before native publication");\n\t\t\t} : undefined,\n\t\t\thasDeps: false,`,
    );
  if (
    countOccurrences(text, INSTALL_INTEGRITY_MARKER) !== 1 ||
    !text.includes("nemoClawNormalizedSkillDigest(stageDir)")
  ) {
    throw new Error(`${filePath}: skill install state integrity patch verification failed`);
  }
  return { status: "patched", text };
}

/** Resolve both reviewed generated skill lifecycle modules in one bounded scan. */
function resolveTargets(distDir: string): { installStateFile: string; skillsCliFile: string } {
  const skillsCliFiles: string[] = [];
  const installStateFiles: string[] = [];
  for (const file of listJsFiles(distDir)) {
    const source = fs.readFileSync(file, "utf8");
    if (source.includes(TARGET_SIGNATURE)) skillsCliFiles.push(file);
    if (
      source.includes(INSTALL_STATE_FUNCTION_ANCHOR) &&
      source.includes(INSTALL_STATE_COPY_ANCHOR)
    ) {
      installStateFiles.push(file);
    }
  }
  if (skillsCliFiles.length !== 1 || installStateFiles.length !== 1) {
    throw new Error(
      `Expected one OpenClaw skills CLI and publication module, found ${skillsCliFiles.length} and ${installStateFiles.length}`,
    );
  }
  return { installStateFile: installStateFiles[0], skillsCliFile: skillsCliFiles[0] };
}

/** Apply the native remove capability only to the pinned reviewed OpenClaw version. */
export function patchOpenClawSkillRemove(distDir: string): {
  status: PatchStatus | "skipped-unsupported-version";
  version: string;
  file?: string;
  installStateFile?: string;
} {
  const resolved = path.resolve(distDir);
  const version = readOpenClawVersion(resolved);
  if (version !== SUPPORTED_OPENCLAW_VERSION) {
    if (LEGACY_FIXTURE_OPENCLAW_VERSIONS.has(version)) {
      return { status: "skipped-unsupported-version", version };
    }
    throw new Error(`OpenClaw ${version} is not reviewed for native skill lifecycle patching`);
  }
  const { installStateFile, skillsCliFile: file } = resolveTargets(resolved);
  const installResult = patchSkillInstallCliText(fs.readFileSync(file, "utf8"), file);
  const removeResult = patchSkillRemoveText(installResult.text, file);
  const stateResult = patchSkillInstallStateText(
    fs.readFileSync(installStateFile, "utf8"),
    installStateFile,
  );
  if (installResult.status === "patched" || removeResult.status === "patched") {
    fs.writeFileSync(file, removeResult.text);
  }
  if (stateResult.status === "patched") fs.writeFileSync(installStateFile, stateResult.text);
  const status =
    installResult.status === "patched" ||
    removeResult.status === "patched" ||
    stateResult.status === "patched"
      ? "patched"
      : "already-patched";
  return { status, version, file, installStateFile };
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
      throw new Error("native skill lifecycle patch is not applied");
    }
    console.log(`INFO: OpenClaw native skill lifecycle ${result.status} (${result.version})`);
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(SCRIPT_PATH)) {
  process.exitCode = main(process.argv);
}
