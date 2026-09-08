// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildCliOpenShellSandboxExecArgs } from "../../adapters/openshell/sandbox-command-cli";
import { createSdkOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-sdk";
import {
  captureOpenshell,
  OPENSHELL_OPERATION_TIMEOUT_MS,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import { renderAgentSkillCommand } from "../../agent/skill-integration";
import { CLI_NAME } from "../../cli/branding";
import { D, G, R } from "../../cli/terminal-style";
import * as skillInstall from "../../skill-install";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { wrapExecCommandWithRuntimeEnv } from "./runtime-env";

const SKILL_COMMAND_TIMEOUT_SECONDS = 120;
const skillCommandExecutor = createSdkOpenShellSandboxCommandExecutor();

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

export function printSkillInstallUsage(): void {
  console.log("");
  console.log(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
  console.log(`         ${CLI_NAME} <sandbox> skill remove <name>`);
  console.log(`         ${CLI_NAME} <sandbox> skill list [agent-skill-list-flags...]`);
  console.log("");
  console.log("  Delegate skill state to the selected agent.");
  console.log("");
  console.log(
    "  install <path>  Add a local SKILL.md tree through the agent's declared integration.",
  );
  console.log(
    "  remove <name>   Remove through the native command or only from its canonical writable root.",
  );
  console.log("  list            Stream the selected agent's native skill list.");
  console.log("");
}

export function looksLikeOpenClawPlugin(candidatePath: string): boolean {
  const dir =
    fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()
      ? candidatePath
      : path.dirname(candidatePath);
  if (!fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, "openclaw.plugin.json"))) return true;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const openclaw = packageJson?.openclaw;
    return Boolean(
      packageJson?.["openclaw.plugin"] === true ||
      openclaw === true ||
      (openclaw &&
        typeof openclaw === "object" &&
        (openclaw.plugin === true ||
          typeof openclaw.entry === "string" ||
          typeof openclaw.main === "string" ||
          (Array.isArray(openclaw.extensions) && openclaw.extensions.length > 0))),
    );
  } catch {
    return false;
  }
}

function lstatOrNull(candidatePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidatePath);
  } catch {
    return null;
  }
}

function readRegularFileNoFollow(candidatePath: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      candidatePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    if (!fs.fstatSync(descriptor).isFile()) return null;
    return fs.readFileSync(descriptor, "utf8");
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function resolveSelectedSkillAgent(sandboxName: string) {
  const resolution = agentRuntime.resolveSessionAgentDefinition(
    sandboxName,
    agentRuntime.getSessionAgent(sandboxName),
  );
  if (!resolution.resolved) {
    console.error(
      `  Registered agent '${resolution.requestedName}' could not be resolved from a trusted manifest.`,
    );
    process.exitCode = 1;
    return null;
  }
  const integration = resolution.agent.skillIntegration;
  const binary = resolution.agent.binary_path;
  if (!integration || !binary) {
    console.error(`  Agent '${resolution.agent.name}' has no safe skill integration metadata.`);
    process.exitCode = 1;
    return null;
  }
  return { binary, integration };
}

function rejectsAgentOverride(extraArgs: readonly string[]): boolean {
  return (
    extraArgs.includes("--") ||
    extraArgs.some((argument) => argument === "--agent" || argument.startsWith("--agent="))
  );
}

function runCliSandboxCommand(
  sandboxName: string,
  gatewayName: string,
  command: readonly string[],
): number {
  const result = runOpenshell(
    buildCliOpenShellSandboxExecArgs({
      sandboxName,
      target: { kind: "named", gatewayName },
      command,
      tty: false,
      timeoutSeconds: SKILL_COMMAND_TIMEOUT_SECONDS,
    }),
    {
      ignoreError: true,
      killProcessTreeOnTimeout: true,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: SKILL_COMMAND_TIMEOUT_SECONDS * 1000,
    },
  );
  return result.status ?? 1;
}

async function runSandboxCommand(
  sandboxName: string,
  gatewayName: string,
  command: readonly string[],
): Promise<number> {
  const completion = await skillCommandExecutor.runStreaming({
    sandboxName,
    target: { kind: "named", gatewayName },
    command,
    tty: false,
    timeoutSeconds: SKILL_COMMAND_TIMEOUT_SECONDS,
  });
  try {
    if (completion.outcome.kind === "completed") return completion.outcome.exitCode;
    if (completion.outcome.error.kind === "unavailable") {
      return runCliSandboxCommand(sandboxName, gatewayName, command);
    }
    console.error(`  OpenShell SDK execution failed: ${completion.outcome.error.message}`);
    return 1;
  } finally {
    completion.release();
  }
}

async function cleanupRemoteStage(
  sandboxName: string,
  gatewayName: string,
  stageDirectory: string,
): Promise<boolean> {
  const exitCode = await runSandboxCommand(sandboxName, gatewayName, [
    "/bin/sh",
    "-c",
    skillInstall.buildCleanupSkillStageCommand(stageDirectory),
  ]);
  if (exitCode !== 0) console.error("  Private skill staging cleanup failed.");
  return exitCode === 0;
}

function runAgentSkillCommand(
  sandboxName: string,
  gatewayName: string,
  command: readonly string[],
): Promise<number> {
  return runSandboxCommand(sandboxName, gatewayName, wrapExecCommandWithRuntimeEnv(command));
}

async function runSkillCommandWithStageCleanup(
  sandboxName: string,
  gatewayName: string,
  stageDirectory: string,
  command: readonly string[],
): Promise<void> {
  const commandExit = await runAgentSkillCommand(sandboxName, gatewayName, command);
  const cleaned = await cleanupRemoteStage(sandboxName, gatewayName, stageDirectory);
  process.exitCode = cleaned || commandExit !== 0 ? commandExit : 1;
}

/** Stream the unmodified selected agent's native skill list. */
export async function listSandboxSkills(
  sandboxName: string,
  request: SkillListRequest = {},
): Promise<void> {
  await ensureLiveSandboxOrExit(sandboxName, { selectOwningGateway: false });
  const selected = resolveSelectedSkillAgent(sandboxName);
  if (!selected) return;
  const extraArgs = request.extraArgs ?? [];
  if (rejectsAgentOverride(extraArgs)) {
    console.error("  `skill list` is bound to the sandbox's selected agent.");
    process.exitCode = 2;
    return;
  }
  const gatewayName = getSandboxTargetGatewayName(sandboxName);
  process.exitCode = await runAgentSkillCommand(sandboxName, gatewayName, [
    ...renderAgentSkillCommand(selected.binary, selected.integration.listCommand),
    ...extraArgs,
  ]);
}

/** Invoke native removal when available; otherwise delete only the canonical-root copy. */
export async function removeSandboxSkill(
  sandboxName: string,
  request: SkillRemoveRequest = {},
): Promise<void> {
  const skillName = request.name;
  if (skillName === "--help" || skillName === "-h") {
    printSkillInstallUsage();
    return;
  }
  if (!skillName || (request.extraArgs ?? []).length > 0) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill remove <name>`);
    process.exit(2);
  }
  if (!skillInstall.validateSkillName(skillName)) {
    console.error(`  Invalid skill name: '${skillName}'`);
    process.exit(2);
  }

  await ensureLiveSandboxOrExit(sandboxName, { selectOwningGateway: false });
  const selected = resolveSelectedSkillAgent(sandboxName);
  if (!selected) return;
  const native = selected.integration.removeCommand;
  const command = native
    ? renderAgentSkillCommand(selected.binary, native, { name: skillName })
    : skillInstall.buildCanonicalSkillRemoveCommand(selected.integration.writableRoot, skillName);
  process.exitCode = await runAgentSkillCommand(
    sandboxName,
    getSandboxTargetGatewayName(sandboxName),
    command,
  );
}

function resolveLocalSkill(skillPath: string): {
  directory: string;
  name: string;
  rootIdentity: skillInstall.SkillRootIdentity;
} | null {
  const resolvedPath = path.resolve(skillPath);
  const resolvedStat = lstatOrNull(resolvedPath);
  if (resolvedStat?.isSymbolicLink()) {
    console.error(`  Skill path '${resolvedPath}' must not be a symbolic link.`);
    return null;
  }
  const directory = resolvedStat?.isDirectory()
    ? resolvedPath
    : resolvedStat?.isFile() && path.basename(resolvedPath) === "SKILL.md"
      ? path.dirname(resolvedPath)
      : null;
  if (!directory) {
    console.error(`  No SKILL.md found at '${resolvedPath}'.`);
    if (looksLikeOpenClawPlugin(resolvedPath)) printPluginInstallHint();
    return null;
  }
  const directoryStat = lstatOrNull(directory);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    console.error(`  Skill directory '${directory}' must remain a regular directory.`);
    return null;
  }
  const skillFile = path.join(directory, "SKILL.md");
  if (!lstatOrNull(skillFile)) {
    console.error(`  No SKILL.md found in '${directory}'.`);
    if (looksLikeOpenClawPlugin(directory)) printPluginInstallHint();
    return null;
  }
  const source = readRegularFileNoFollow(skillFile);
  if (source === null) {
    console.error(`  SKILL.md in '${directory}' must be a regular file.`);
    return null;
  }
  try {
    return {
      directory,
      name: skillInstall.parseFrontmatter(source).name,
      rootIdentity: { dev: directoryStat.dev, ino: directoryStat.ino },
    };
  } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function printPluginInstallHint(): void {
  console.error("  This looks like an OpenClaw plugin, not a SKILL.md agent skill.");
  console.error("  `skill install` accepts only agent skills.");
}

/** Validate and stage a local tree, then invoke native add or one canonical-root placement. */
export async function installSandboxSkill(
  sandboxName: string,
  request: SkillInstallRequest = {},
): Promise<void> {
  const subcommand = request.command;
  if (!subcommand || ["help", "--help", "-h"].includes(subcommand)) {
    printSkillInstallUsage();
    return;
  }
  if (subcommand === "list") {
    await listSandboxSkills(sandboxName, {
      extraArgs: [request.path, ...(request.extraArgs ?? [])].filter(
        (value): value is string => typeof value === "string",
      ),
    });
    return;
  }
  if (subcommand === "remove") {
    await removeSandboxSkill(sandboxName, {
      command: "remove",
      name: request.path,
      extraArgs: request.extraArgs,
    });
    return;
  }
  if (subcommand !== "install") {
    console.error(`  Unknown skill subcommand: ${subcommand}`);
    process.exit(2);
  }
  if (!request.path || (request.extraArgs ?? []).length > 0) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> skill install <path>`);
    process.exit(2);
  }

  const local = resolveLocalSkill(request.path);
  if (!local) {
    process.exitCode = 1;
    return;
  }
  const snapshotResult = skillInstall.createStatelessSkillSnapshot(
    local.directory,
    local.name,
    local.rootIdentity,
  );
  if (!snapshotResult.success) {
    if (snapshotResult.reason === "limit-exceeded") {
      console.error(
        `  Skill exceeds the ${skillInstall.SKILL_SNAPSHOT_MAX_FILES}-file or ${String(skillInstall.SKILL_SNAPSHOT_MAX_BYTES / (1024 * 1024))} MiB limit.`,
      );
    } else if (snapshotResult.reason === "invalid-tree") {
      console.error(
        `  Skill contains an unsafe, symbolic-link, or special path${snapshotResult.paths?.length ? `: ${snapshotResult.paths.join(", ")}` : "."}`,
      );
    } else {
      console.error("  Skill source changed while it was being read; no sandbox add began.");
    }
    process.exitCode = 1;
    return;
  }

  const snapshot = snapshotResult.snapshot;
  if (snapshot.skippedDotfiles.length > 0) {
    console.log(`  ${D}Skipping hidden paths: ${snapshot.skippedDotfiles.join(", ")}${R}`);
  }
  console.log(
    `  ${G}✓${R} Validated SKILL.md (name: ${local.name}, ${String(snapshot.files.length)} file(s))`,
  );

  const stageDirectory = `/sandbox/.nemoclaw-skill-stage.${randomBytes(16).toString("hex")}`;
  const stagedSkillDirectory = `${stageDirectory}/${local.name}`;
  let gatewayName = "";
  let stageCreated = false;
  try {
    await ensureLiveSandboxOrExit(sandboxName, { selectOwningGateway: false });
    const selected = resolveSelectedSkillAgent(sandboxName);
    if (!selected) return;
    gatewayName = getSandboxTargetGatewayName(sandboxName);
    const prepareExit = await runSandboxCommand(sandboxName, gatewayName, [
      "/bin/sh",
      "-c",
      skillInstall.buildPrepareSkillStageCommand(stageDirectory),
    ]);
    if (prepareExit !== 0) {
      console.error("  Private skill staging failed.");
      process.exitCode = 1;
      return;
    }
    stageCreated = true;

    const upload = captureOpenshell(
      // OpenShell SDK 0.0.106 has sandbox exec but no upload/sync API. Keep
      // only this bounded transfer on the existing provider-neutral CLI path.
      [
        "sandbox",
        "upload",
        "-g",
        gatewayName,
        sandboxName,
        snapshot.skillDirectory,
        `${stageDirectory}/`,
      ],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      },
    );
    if (upload.status !== 0) {
      const detail = upload.output.trim();
      console.error(`  Skill snapshot upload failed${detail ? `: ${detail}` : "."}`);
      process.exitCode = 1;
      return;
    }

    const native = selected.integration.addCommand;
    const command = native
      ? renderAgentSkillCommand(selected.binary, native, { source: stagedSkillDirectory })
      : skillInstall.buildCanonicalSkillAddCommand(
          selected.integration.writableRoot,
          local.name,
          stagedSkillDirectory,
        );
    await runSkillCommandWithStageCleanup(sandboxName, gatewayName, stageDirectory, command);
    stageCreated = false;
  } finally {
    if (stageCreated && gatewayName) {
      await cleanupRemoteStage(sandboxName, gatewayName, stageDirectory);
    }
    snapshot.cleanup();
  }
}
