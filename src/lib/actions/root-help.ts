// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AGENT_PRODUCT_NAME, CLI_DISPLAY_NAME, CLI_NAME } from "../cli/branding";
import { commandsByGroup, visibleCommands, type CommandDef } from "../cli/command-registry";
import { getRegisteredOclifCommandSummary } from "../cli/oclif-metadata";
import { getVersion } from "../core/version";

const useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const trueColor =
  useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = useColor ? (trueColor ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = useColor ? "\x1b[1m" : "";
const D = useColor ? "\x1b[2m" : "";
const R = useColor ? "\x1b[0m" : "";

function hasDisplaySpecificDescription(command: CommandDef): boolean {
  const sameCommandId = visibleCommands().filter((entry) => entry.commandId === command.commandId);
  return new Set(sameCommandId.map((entry) => entry.description)).size > 1;
}

function getDisplayDescription(command: CommandDef): string {
  if (hasDisplaySpecificDescription(command)) {
    return command.description;
  }
  return getRegisteredOclifCommandSummary(command.commandId) ?? command.description;
}

export function version(): void {
  console.log(`${CLI_NAME} v${getVersion()}`);
}

/** Print CLI usage with all commands, flags, and reconfiguration guidance. */
export function help(): void {
  const PAD = 38; // column width for usage strings before description
  const grouped = commandsByGroup();
  const lines = [];

  lines.push("");
  lines.push(`  ${B}${G}${CLI_DISPLAY_NAME}${R}  ${D}v${getVersion()}${R}`);
  lines.push(`  ${D}Deploy more secure, always-on AI assistants with a single command.${R}`);

  for (const [group, cmds] of grouped) {
    lines.push("");
    lines.push(`  ${G}${group}:${R}`);

    let isFirstInGroup = true;
    for (const cmd of cmds) {
      const usage = cmd.usage;
      const desc = getDisplayDescription(cmd);
      const flags = cmd.flags ? ` ${D}${cmd.flags}${R}` : "";

      const prefix = isFirstInGroup ? B : "";
      const suffix = isFirstInGroup ? R : "";
      const dPrefix = cmd.deprecated ? D : "";
      const dSuffix = cmd.deprecated ? R : "";

      const displayUsage = `${dPrefix}${prefix}${usage}${suffix}${dSuffix}`;
      const displayDesc = cmd.deprecated ? `${D}${desc}${R}` : desc;
      const padding = Math.max(1, PAD - usage.length);
      lines.push(`    ${displayUsage}${" ".repeat(padding)}${displayDesc}${flags}`);

      isFirstInGroup = false;
    }
  }

  lines.push("");
  lines.push(`  ${G}Uninstall flags:${R}`);
  lines.push(`    --yes${" ".repeat(29)}Skip the confirmation prompt`);
  lines.push(`    --keep-openshell${" ".repeat(18)}Leave the openshell binary installed`);
  lines.push(`    --delete-models${" ".repeat(19)}Remove ${CLI_DISPLAY_NAME}-pulled Ollama models`);

  lines.push("");
  lines.push(`  ${G}Reconfiguration (after onboard):${R}`);
  lines.push(
    `    ${D}• Change inference model:  nemoclaw inference set --model <model> --provider <provider>${R}`,
  );
  lines.push(`    ${D}• Add network presets:     use the policy-add command on your sandbox${R}`);
  lines.push(
    `    ${D}• Change credentials:      credentials reset <PROVIDER>, then re-run onboard${R}`,
  );
  lines.push(`    ${D}• Agent config is read-only inside the sandbox (Landlock enforced).${R}`);
  lines.push(
    `    ${D}  To change ${AGENT_PRODUCT_NAME} settings, re-run onboard to rebuild the sandbox.${R}`,
  );

  lines.push("");
  lines.push(`  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit`);
  lines.push(`  Credentials registered with the OpenShell gateway${R}`);
  lines.push(`  ${D}https://www.nvidia.com/nemoclaw${R}`);
  lines.push("");

  console.log(lines.join("\n"));
}
