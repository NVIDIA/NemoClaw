// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureSandboxSshConfig } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R, YW } from "../../cli/terminal-style";
import * as skillInstall from "../../skill-install";
import { ensureLiveSandboxOrExit } from "./gateway-state";

export function printSkillInstallUsage(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
  console.log(`         ${CLI_NAME} <sandbox> skill remove <name>`);
  console.log("");
  console.log("  Deploy or remove a skill in a running sandbox.");
  console.log("");
  console.log("  install <path>  Deploy a skill directory to the sandbox.");
  console.log(
    "    <path> must be a skill directory containing a SKILL.md (with 'name:' frontmatter),",
  );
  console.log(
    "    or a direct path to a SKILL.md file. All non-dot files in the directory are uploaded.",
  );
  console.log("");
  console.log("  remove <name>   Remove an installed skill from the sandbox by name.");
  console.log("    <name> is the skill name from SKILL.md frontmatter (e.g. my-skill).");
  console.log("");
}

export function looksLikeOpenClawPlugin(candidatePath: string): boolean {
  const dir =
    fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
      ? candidatePath
      : path.dirname(candidatePath);
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return true;

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const openclawBlock = packageJson?.openclaw;
    return Boolean(
      packageJson?.["openclaw.plugin"] === true ||
        openclawBlock === true ||
        (typeof openclawBlock === "object" &&
          openclawBlock !== null &&
          (openclawBlock.plugin === true ||
            typeof openclawBlock.entry === "string" ||
            typeof openclawBlock.main === "string" ||
            (Array.isArray(openclawBlock.extensions) && openclawBlock.extensions.length > 0))),
    );
  } catch {
    return false;
  }
}

export type SkillInstallRequest = {
  command?: string;
  path?: string;
  extraArgs?: string[];
};

export type SkillRemoveRequest = {
  command?: string;
  name?: string;
  extraArgs?: string[];
};

export function printPluginInstallHint(): void {
  console.error("  This looks like an OpenClaw plugin, not a SKILL.md agent skill.");
  console.error("  `skill install` only accepts skill directories or direct SKILL.md paths.");
  console.error(
    "  To use an OpenClaw plugin today, bake it into a custom sandbox image with `nemoclaw onboard --from <Dockerfile>`.",
  );
}

/**
 * Remove an installed skill from a live sandbox by name.
 */
export async function removeSandboxSkill(
  sandboxName: string,
  request: SkillRemoveRequest = {},
): Promise<void> {
  const skillName = request.name;
  const extraArgs = request.extraArgs ?? [];
  if (skillName === "--help" || skillName === "-h") {
    printSkillInstallUsage();
    return;
  }
  if (extraArgs.length > 0) {
    console.error(`  Unknown argument(s) for skill remove: ${extraArgs.join(", ")}`);
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill remove <name>`);
    process.exit(1);
  }
  if (!skillName) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill remove <name>`);
    console.error("  <name> is the skill name from the SKILL.md frontmatter.");
    process.exit(1);
  }
  if (!skillInstall.validateSkillName(skillName)) {
    console.error(`  Invalid skill name: '${skillName}'`);
    console.error("  Skill names must match [A-Za-z0-9._-] and must not be '.' or '..'.");
    process.exit(1);
  }

  await ensureLiveSandboxOrExit(sandboxName);

  const agent = agentRuntime.getSessionAgent(sandboxName);
  const paths = skillInstall.resolveSkillPaths(agent, skillName);

  const sshConfigResult = captureSandboxSshConfig(sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (sshConfigResult.status !== 0) {
    console.error("  Failed to obtain SSH configuration for the sandbox.");
    process.exit(1);
  }

  const tmpSshConfig = path.join(
    os.tmpdir(),
    `nemoclaw-ssh-skill-${process.pid}-${Date.now()}.conf`,
  );
  fs.writeFileSync(tmpSshConfig, sshConfigResult.output, { mode: 0o600 });

  try {
    const ctx = { configFile: tmpSshConfig, sandboxName };

    const existsCheck = skillInstall.checkExisting(ctx, paths);
    if (existsCheck === null) {
      console.error(
        `  Could not check if skill '${skillName}' exists — sandbox may be unreachable.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!existsCheck) {
      console.error(`  Skill '${skillName}' is not installed in sandbox '${sandboxName}'.`);
      process.exitCode = 1;
      return;
    }

    const result = skillInstall.removeSkill(ctx, paths);
    for (const msg of result.messages) {
      if (msg.startsWith("Warning:")) {
        console.error(`  ${YW}${msg}${R}`);
      } else {
        console.log(`  ${D}${msg}${R}`);
      }
    }

    const gone = skillInstall.verifyRemove(ctx, paths);
    if (gone) {
      console.log(`  ${G}✓${R} Skill '${skillName}' removed`);
    } else {
      console.error("  Skill removal could not be verified.");
      console.error("  The sandbox may be unreachable, or the skill directory may still exist.");
      process.exitCode = 1;
      return;
    }
  } finally {
    try {
      fs.unlinkSync(tmpSshConfig);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Install or update a local skill directory into a live sandbox and perform
 * any agent-specific post-install refresh needed for the new content to load.
 */
export async function installSandboxSkill(
  sandboxName: string,
  request: SkillInstallRequest = {},
): Promise<void> {
  const sub = request.command;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printSkillInstallUsage();
    return;
  }

  if (sub === "remove") {
    await removeSandboxSkill(sandboxName, {
      command: "remove",
      name: request.path,
      extraArgs: request.extraArgs,
    });
    return;
  }

  if (sub !== "install") {
    console.error(`  Unknown skill subcommand: ${sub}`);
    console.error("  Valid subcommands: install, remove");
    process.exit(1);
  }

  const skillPath = request.path;
  const extraArgs = request.extraArgs ?? [];
  if (skillPath === "--help" || skillPath === "-h" || skillPath === "help") {
    printSkillInstallUsage();
    return;
  }
  if (extraArgs.length > 0) {
    console.error(`  Unknown argument(s) for skill install: ${extraArgs.join(", ")}`);
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
    process.exit(1);
  }
  if (!skillPath) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
    console.error("  <path> must be a directory containing a SKILL.md file.");
    process.exit(1);
  }

  const resolvedPath = path.resolve(skillPath);

  // Accept a directory containing SKILL.md, or a direct path to SKILL.md.
  let skillDir: string;
  let skillMdPath: string;
  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    skillDir = resolvedPath;
    skillMdPath = path.join(resolvedPath, "SKILL.md");
  } else if (fs.existsSync(resolvedPath) && resolvedPath.endsWith("SKILL.md")) {
    skillDir = path.dirname(resolvedPath);
    skillMdPath = resolvedPath;
  } else {
    console.error(`  No SKILL.md found at '${resolvedPath}'.`);
    console.error("  <path> must be a skill directory or a direct path to SKILL.md.");
    if (looksLikeOpenClawPlugin(resolvedPath)) {
      printPluginInstallHint();
    }
    process.exit(1);
  }

  if (!fs.existsSync(skillMdPath)) {
    console.error(`  No SKILL.md found in '${skillDir}'.`);
    console.error("  The skill directory must contain a SKILL.md file.");
    if (looksLikeOpenClawPlugin(skillDir)) {
      printPluginInstallHint();
    }
    process.exit(1);
  }

  // 1. Validate frontmatter
  let frontmatter;
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    frontmatter = skillInstall.parseFrontmatter(content);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`  ${errorMessage}`);
    process.exit(1);
  }

  const collected = skillInstall.collectFiles(skillDir);
  if (collected.unsafePaths.length > 0) {
    console.error("  Skill directory contains files with unsafe characters:");
    for (const p of collected.unsafePaths) console.error(`    ${p}`);
    console.error("  File names must match [A-Za-z0-9._-/]. Rename or remove them.");
    process.exit(1);
  }
  if (collected.skippedDotfiles.length > 0) {
    console.log(
      `  ${D}Skipping ${collected.skippedDotfiles.length} hidden path(s): ${collected.skippedDotfiles.join(", ")}${R}`,
    );
  }
  const fileLabel = collected.files.length === 1 ? "1 file" : `${collected.files.length} files`;
  console.log(`  ${G}✓${R} Validated SKILL.md (name: ${frontmatter.name}, ${fileLabel})`);

  // 2. Ensure sandbox is live
  await ensureLiveSandboxOrExit(sandboxName);

  // 3. Resolve agent and paths
  const agent = agentRuntime.getSessionAgent(sandboxName);
  const paths = skillInstall.resolveSkillPaths(agent, frontmatter.name);

  // 4. Get SSH config
  const sshConfigResult = captureSandboxSshConfig(sandboxName, {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (sshConfigResult.status !== 0) {
    console.error("  Failed to obtain SSH configuration for the sandbox.");
    process.exit(1);
  }

  const tmpSshConfig = path.join(
    os.tmpdir(),
    `nemoclaw-ssh-skill-${process.pid}-${Date.now()}.conf`,
  );
  fs.writeFileSync(tmpSshConfig, sshConfigResult.output, { mode: 0o600 });

  try {
    const ctx = { configFile: tmpSshConfig, sandboxName };

    // 5. Check if skill already exists (update vs fresh install). This probe is
    //    advisory for install only: stale SSH config files and transient remote
    //    shell startup failures can make the stat probe inconclusive even when a
    //    subsequent upload succeeds. Upload plus verifyInstall() remain the
    //    source of truth for install success; remove keeps null fatal because it
    //    is destructive. Once OpenShell exposes a typed stat API or SSH probe
    //    failures are reliably distinguishable from absent dirs across supported
    //    versions, remove this fallback and fail before upload.
    const existingCheck = skillInstall.checkExisting(ctx, paths);
    if (existingCheck === null) {
      console.error(
        `  ${YW}Warning: could not check sandbox for existing skill — treating as fresh install.${R}`,
      );
    }
    const isUpdate = existingCheck === true;

    // 6. Upload skill directory
    const { uploaded, failed } = skillInstall.uploadDirectory(ctx, skillDir, paths.uploadDir);
    if (failed.length > 0) {
      console.error(`  Failed to upload ${failed.length} file(s): ${failed.join(", ")}`);
      process.exit(1);
    }
    console.log(`  ${G}✓${R} Uploaded ${uploaded} file(s) to sandbox`);

    // 7. Post-install (OpenClaw mirror + refresh, or restart hint).
    //    OpenClaw caches skill content per session, so always refresh the
    //    session index after an install/update to avoid stale SKILL.md data.
    const post = skillInstall.postInstall(ctx, paths, skillDir);
    for (const msg of post.messages) {
      if (msg.startsWith("Warning:")) {
        console.error(`  ${YW}${msg}${R}`);
      } else {
        console.log(`  ${D}${msg}${R}`);
      }
    }

    // 8. Verify
    const verified = skillInstall.verifyInstall(ctx, paths);
    if (verified) {
      const verb = isUpdate ? "updated" : "installed";
      console.log(`  ${G}✓${R} Skill '${frontmatter.name}' ${verb}`);
    } else {
      console.error(
        `  Skill uploaded but verification failed: SKILL.md missing at ${paths.uploadDir}` +
          (paths.isOpenClaw && paths.mirrorDir ? ` or its agent mirror ${paths.mirrorDir}` : ""),
      );
      process.exit(1);
    }
  } finally {
    try {
      fs.unlinkSync(tmpSshConfig);
    } catch {
      /* ignore */
    }
  }
}
