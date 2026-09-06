// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import {
  fingerprintOpenShellSandboxSshConfigTarget,
  fingerprintOpenShellSandboxSshTarget,
} from "../../adapters/openshell/sandbox-identity";
import { inspectOpenShellSandboxIdentityFingerprint } from "../../adapters/openshell/sandbox-identity-cli";
import { captureSandboxSshConfig } from "../../adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import * as agentRuntime from "../../agent/runtime";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R } from "../../cli/terminal-style";
import {
  deferSandboxLifecycleExit,
  runWithDeferredSandboxLifecycleExit,
} from "../../core/process-exit";
import { createTempSshConfig } from "../../sandbox/temp-ssh-config";
import { withSandboxMutationLock } from "../../state/mcp-lifecycle-lock";
import * as skillInstall from "../../skill-install";
import { execSandbox } from "./exec";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { getSandboxTargetGatewayName } from "./gateway-target";

const NATIVE_SKILL_LIST_TIMEOUT_SECONDS = 30;
const NATIVE_SKILL_REMOVE_TIMEOUT_SECONDS = 120;
const NATIVE_SKILL_REMOVE_INNER_TIMEOUT_SECONDS = 110;

function resolveNativeSkillAgent(sandboxName: string) {
  const resolution = agentRuntime.resolveSessionAgentDefinition(
    sandboxName,
    agentRuntime.getSessionAgent(sandboxName),
  );
  if (!resolution.resolved) {
    console.error(
      `  Registered agent '${resolution.requestedName}' could not be resolved from a trusted manifest; refusing native skill lifecycle access.`,
    );
    process.exitCode = 1;
    return null;
  }
  return resolution.agent;
}

export function printSkillInstallUsage(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
  console.log(`         ${CLI_NAME} <sandbox> skill remove <name>`);
  console.log(`         ${CLI_NAME} <sandbox> skill list [agent-skill-list-flags...]`);
  console.log("");
  console.log("  Install, remove, or list skills in a running sandbox.");
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
  console.log("  list            List skills from the selected agent's native state.");
  console.log("");
}

/** Return whether a directory declares an OpenClaw plugin package. */
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

export type SkillListRequest = {
  extraArgs?: string[];
};

function lstatOrNull(candidatePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidatePath);
  } catch {
    return null;
  }
}

type RegularFileRead =
  | { content: string; success: true }
  | { reason: "invalid" | "missing"; success: false };

function readRegularFileNoFollow(candidatePath: string): RegularFileRead {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonblock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== "number" || typeof nonblock !== "number") {
    return { reason: "invalid", success: false };
  }

  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidatePath, fs.constants.O_RDONLY | noFollow | nonblock);
    if (!fs.fstatSync(descriptor).isFile()) return { reason: "invalid", success: false };
    return { content: fs.readFileSync(descriptor, "utf8"), success: true };
  } catch (error) {
    return {
      reason:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "missing"
          : "invalid",
      success: false,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

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

  const agent = resolveNativeSkillAgent(sandboxName);
  if (!agent) return;
  const lifecycle = skillInstall.getNativeSkillLifecycle(agent);
  if (!lifecycle) {
    console.error(`  Agent '${agent?.name ?? "unknown"}' has no native skill remove command.`);
    process.exitCode = 1;
    return;
  }
  const agentName = lifecycle.agentName;
  const command = lifecycle.remove(skillName);
  let bindingFailed = false;
  let capabilityMissing = false;
  let sshConfigFailed = false;
  await runWithDeferredSandboxLifecycleExit(() =>
    withSandboxMutationLock(sandboxName, async () => {
      const gatewayName = getSandboxTargetGatewayName(sandboxName);
      const sshConfigResult = captureSandboxSshConfig(sandboxName, {
        gatewayName,
        ignoreError: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      });
      if (sshConfigResult.status !== 0) {
        sshConfigFailed = true;
        return;
      }
      const observedSshTarget = fingerprintOpenShellSandboxSshConfigTarget(sshConfigResult.output);
      const expectedSshTarget = fingerprintOpenShellSandboxSshTarget(
        gatewayName,
        sandboxName,
        "default",
      );
      if (!observedSshTarget || !expectedSshTarget || observedSshTarget !== expectedSshTarget) {
        bindingFailed = true;
        return;
      }
      let expectedIdentity: string;
      let confirmedIdentity: string;
      try {
        expectedIdentity = inspectOpenShellSandboxIdentityFingerprint({
          sandboxName,
          gatewayName,
          timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
        });
        confirmedIdentity = inspectOpenShellSandboxIdentityFingerprint({
          sandboxName,
          gatewayName,
          timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
        });
      } catch {
        bindingFailed = true;
        return;
      }
      if (expectedIdentity !== confirmedIdentity) {
        bindingFailed = true;
        return;
      }
      if (agentName === "openclaw") {
        const tmpSshConfig = createTempSshConfig(
          sshConfigResult.output,
          "nemoclaw-ssh-skill-remove-",
        );
        try {
          if (
            !skillInstall.probeOpenClawSkillRemoveCapability(
              { configFile: tmpSshConfig.file, sandboxName },
              expectedIdentity,
              lifecycle,
            )
          ) {
            capabilityMissing = true;
            return;
          }
        } finally {
          tmpSshConfig.cleanup();
        }
      }
      const identityBoundCommand = skillInstall.bindNativeSkillCommandToSandboxIdentity(
        command,
        expectedIdentity,
        {
          diagnostic: `Native ${lifecycle.displayName} skill removal timed out in sandbox '${sandboxName}' while running '${command.slice(0, 3).join(" ")}'. Inspect current agent state with '${CLI_NAME} ${sandboxName} skill list' before retrying.`,
          seconds: NATIVE_SKILL_REMOVE_INNER_TIMEOUT_SECONDS,
        },
      );
      await execSandbox(
        sandboxName,
        identityBoundCommand,
        { timeoutSeconds: NATIVE_SKILL_REMOVE_TIMEOUT_SECONDS },
        { exit: deferSandboxLifecycleExit },
      );
    }),
  );
  if (sshConfigFailed || bindingFailed || capabilityMissing) {
    console.error(
      sshConfigFailed
        ? "  Failed to obtain SSH configuration for the sandbox."
        : capabilityMissing
          ? `  This OpenClaw sandbox image does not expose native skill removal. Rebuild it with '${CLI_NAME} ${sandboxName} rebuild' and retry; rebuild preserves both workspace and legacy global skill directories.`
          : `  Failed to bind the ${lifecycle.displayName} skill removal to the exact live sandbox identity.`,
    );
    process.exitCode = 1;
  }
}

/** List skills from the selected agent's native state without a host-side inventory. */
export async function listSandboxSkills(
  sandboxName: string,
  request: SkillListRequest = {},
): Promise<void> {
  const extraArgs = request.extraArgs ?? [];
  await ensureLiveSandboxOrExit(sandboxName);
  const agent = resolveNativeSkillAgent(sandboxName);
  if (!agent) return;
  const lifecycle = skillInstall.getNativeSkillLifecycle(agent);
  if (!lifecycle) {
    console.error(`  Agent '${agent?.name ?? "unknown"}' has no native skill list command.`);
    process.exitCode = 1;
    return;
  }
  if (
    extraArgs.includes("--") ||
    (lifecycle.agentName !== "hermes" &&
      extraArgs.some((arg) => arg === "--agent" || arg.startsWith("--agent=")))
  ) {
    console.error("  `skill list` is bound to the sandbox's primary agent.");
    process.exitCode = 2;
    return;
  }
  const command = lifecycle.list(extraArgs);
  await execSandbox(
    sandboxName,
    command,
    { timeoutSeconds: NATIVE_SKILL_LIST_TIMEOUT_SECONDS },
    {
      exit: (exitCode): never => {
        if (exitCode !== 0) {
          console.error(
            `  ${lifecycle.displayName} native skill state could not be inspected within the ${NATIVE_SKILL_LIST_TIMEOUT_SECONDS}-second sandbox command bound.`,
          );
          console.error(
            `  Retry '${CLI_NAME} ${sandboxName} skill list' after the sandbox becomes reachable.`,
          );
        }
        process.exit(exitCode);
      },
    },
  );
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

  if (sub === "list") {
    await listSandboxSkills(sandboxName, {
      extraArgs: [request.path, ...(request.extraArgs ?? [])].filter(
        (value): value is string => typeof value === "string",
      ),
    });
    return;
  }

  if (sub !== "install") {
    console.error(`  Unknown skill subcommand: ${sub}`);
    console.error("  Valid subcommands: install, remove, list");
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
  const resolvedStat = lstatOrNull(resolvedPath);
  if (resolvedStat?.isSymbolicLink()) {
    console.error(`  Skill path '${resolvedPath}' must not be a symbolic link.`);
    process.exit(1);
  }

  // Accept a directory containing SKILL.md, or a direct path to SKILL.md.
  let skillDir: string;
  let skillMdPath: string;
  if (resolvedStat?.isDirectory()) {
    skillDir = resolvedPath;
    skillMdPath = path.join(resolvedPath, "SKILL.md");
  } else if (resolvedStat?.isFile() && resolvedPath.endsWith("SKILL.md")) {
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

  const skillDirStat = lstatOrNull(skillDir);
  if (!skillDirStat?.isDirectory() || skillDirStat.isSymbolicLink()) {
    console.error(`  Skill directory '${skillDir}' must remain a regular directory.`);
    process.exit(1);
  }
  const expectedRootIdentity = { dev: skillDirStat.dev, ino: skillDirStat.ino };

  const skillMdRead = readRegularFileNoFollow(skillMdPath);
  if (!skillMdRead.success && skillMdRead.reason === "missing") {
    console.error(`  No SKILL.md found in '${skillDir}'.`);
    console.error("  The skill directory must contain a SKILL.md file.");
    if (looksLikeOpenClawPlugin(skillDir)) {
      printPluginInstallHint();
    }
    process.exit(1);
  }
  if (!skillMdRead.success) {
    console.error(`  SKILL.md at '${skillMdPath}' must be a regular file, not a symbolic link.`);
    process.exit(1);
  }

  // 1. Validate frontmatter
  let frontmatter;
  try {
    frontmatter = skillInstall.parseFrontmatter(skillMdRead.content);
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
  if (collected.unsupportedPaths.length > 0) {
    console.error("  Skill directory contains unsupported non-regular paths:");
    for (const p of collected.unsupportedPaths) console.error(`    ${p}`);
    console.error("  Skills may contain only regular files and directories.");
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
  const agent = resolveNativeSkillAgent(sandboxName);
  if (!agent) return;
  const lifecycle = skillInstall.getNativeSkillLifecycle(agent);
  if (!lifecycle) {
    console.error(
      `  Agent '${agent?.name ?? "unknown"}' has no native local skill import command.`,
    );
    process.exitCode = 1;
    return;
  }
  const agentName = lifecycle.agentName;
  const paths = skillInstall.resolveNativeSkillState(agent);

  let sshConfigFailed = false;
  const native = await withSandboxMutationLock(sandboxName, () => {
    const gatewayName = getSandboxTargetGatewayName(sandboxName);
    const sshConfigResult = captureSandboxSshConfig(sandboxName, {
      gatewayName,
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    if (sshConfigResult.status !== 0) {
      sshConfigFailed = true;
      return null;
    }
    const sshConfigTargetFingerprint = fingerprintOpenShellSandboxSshConfigTarget(
      sshConfigResult.output,
    );
    const expectedSshTargetFingerprint = fingerprintOpenShellSandboxSshTarget(
      gatewayName,
      sandboxName,
      "default",
    );
    if (
      !sshConfigTargetFingerprint ||
      !expectedSshTargetFingerprint ||
      sshConfigTargetFingerprint !== expectedSshTargetFingerprint
    ) {
      return null;
    }
    const tmpSshConfig = createTempSshConfig(sshConfigResult.output, "nemoclaw-ssh-skill-");
    try {
      let sandboxIdentityFingerprint: string;
      try {
        sandboxIdentityFingerprint = inspectOpenShellSandboxIdentityFingerprint({
          sandboxName,
          gatewayName,
          timeoutMs: OPENSHELL_PROBE_TIMEOUT_MS,
        });
      } catch {
        return null;
      }
      const context = { configFile: tmpSshConfig.file, sandboxName };
      return agentName === "openclaw"
        ? skillInstall.installOpenClawSkill(context, skillDir, paths, frontmatter.name, {
            expectedRootIdentity,
            expectedSandboxIdentityFingerprint: sandboxIdentityFingerprint,
            lifecycle,
          })
        : skillInstall.installNativeAgentSkill(
            context,
            skillDir,
            paths,
            lifecycle,
            frontmatter.name,
            {
              expectedRootIdentity,
              expectedSandboxIdentityFingerprint: sandboxIdentityFingerprint,
            },
          );
    } finally {
      tmpSshConfig.cleanup();
    }
  });
  if (!native) {
    console.error(
      sshConfigFailed
        ? "  Failed to obtain SSH configuration for the sandbox."
        : `  Failed to bind the ${lifecycle.displayName} skill install to the exact live sandbox identity.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!native.success || !native.contentDigest) {
    const displayName = lifecycle.displayName;
    if (native.reason === "native_capability_missing") {
      console.error(
        agentName === "openclaw"
          ? "  The pinned OpenClaw runtime does not expose the reviewed native skill install capability."
          : `  The pinned ${displayName} runtime does not expose the reviewed native local skill import capability.`,
      );
      if (agentName === "openclaw") {
        console.error(
          `  Rebuild with '${CLI_NAME} ${sandboxName} rebuild' and retry; rebuild preserves both workspace and legacy global skill directories.`,
        );
      } else {
        console.error(
          `  Rebuild with '${CLI_NAME} ${sandboxName} rebuild' and retry; rebuild preserves ${displayName}'s agent-owned skill state.`,
        );
      }
    } else if (native.reason === "native_install_failed") {
      console.error(`  The ${displayName} native skill import refused or failed the staged skill.`);
    } else if (native.reason === "native_install_timed_out") {
      console.error(`  The ${displayName} native skill import timed out and was terminated.`);
      console.error(
        `  Inspect the result with '${CLI_NAME} ${sandboxName} skill list' before retrying.`,
      );
    } else if (native.reason === "sandbox_identity_changed") {
      console.error(
        `  The ${displayName} sandbox identity changed or could not be proven during native skill installation.`,
      );
    } else if (native.reason === "snapshot_failed") {
      console.error("  Failed to create an exact regular-file snapshot of the local skill.");
    } else if (native.reason === "snapshot_limit_exceeded") {
      console.error(
        `  Skill snapshot exceeds the ${skillInstall.SKILL_SNAPSHOT_MAX_FILES}-file or ${skillInstall.SKILL_SNAPSHOT_MAX_BYTES / (1024 * 1024)} MiB limit; no sandbox install began.`,
      );
    } else if (native.reason === "stage_recovery_failed") {
      console.error(
        `  ${displayName} has an unresolved abandoned skill staging directory; no new native install began.`,
      );
      console.error(
        `  Inspect the reported sandbox path, remove it safely, and retry the install.`,
      );
    } else if (native.reason === "verification_failed") {
      console.error(
        `  ${displayName} imported the skill, but native state or digest verification failed.`,
      );
      console.error(
        `  Inspect the result with '${CLI_NAME} ${sandboxName} skill list' before retrying.`,
      );
    } else {
      console.error(
        `  ${displayName} did not confirm whether the staged native skill import completed.`,
      );
      console.error(
        `  Inspect the result with '${CLI_NAME} ${sandboxName} skill list' before retrying.`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const displayName = lifecycle.displayName;
  console.log(`  ${G}✓${R} Skill '${frontmatter.name}' installed through ${displayName}`);
  console.log(`  ${D}Content digest (SHA-256): ${native.contentDigest}${R}`);
  console.log(`  ${D}Start a new ${displayName} session to load the skill.${R}`);
  return;
}
