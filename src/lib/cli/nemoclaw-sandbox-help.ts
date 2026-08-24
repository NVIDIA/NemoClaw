// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CommandHelp, Help, toStandardizedId } from "@oclif/core";
import type { Interfaces } from "@oclif/core";

const SANDBOX_TOPIC_PREFIX = "sandbox:";
const SANDBOX_NAME_PLACEHOLDER = "<name>";

/**
 * NemoClaw's permanent product grammar is `nemoclaw <name> <action>`, while
 * every sandbox-scoped command's internal oclif id is `sandbox:<action>`
 * (`sandbox:agents:add` etc). oclif's default usage formatter unconditionally
 * renders the id-derived prefix ("sandbox <action>") ahead of any custom
 * `usage` string, so `--help` shows the internal form instead of the
 * documented one for every one of these commands (#10095). Only usage lines
 * that start with the `<name>` placeholder are rewritten; anything else
 * falls back to oclif's default rendering unchanged.
 *
 * `Help.formatCommand` rewrites `command.id`'s `:` separators to the
 * configured `topicSeparator` (a space, here) before handing the command to
 * this class, so the id can arrive as either `sandbox:exec` or
 * `sandbox exec` depending on the caller. Standardize back to `:` first.
 */
function sandboxCommandAction(id: string | undefined, config: Interfaces.Config): string | null {
  if (!id) return null;
  const standardized = toStandardizedId(id, config);
  if (!standardized.startsWith(SANDBOX_TOPIC_PREFIX)) return null;
  const action = standardized.slice(SANDBOX_TOPIC_PREFIX.length).replaceAll(":", " ").trim();
  return action.length > 0 ? action : null;
}

export class SandboxScopedCommandHelp extends CommandHelp {
  protected usage(): string {
    const action = sandboxCommandAction(this.command.id, this.config);
    const rawUsage = this.command.usage;
    if (!action || !rawUsage) return super.usage();

    const lines = Array.isArray(rawUsage) ? rawUsage : [rawUsage];
    if (lines.length === 0 || !lines.every((line) => line.startsWith(SANDBOX_NAME_PLACEHOLDER))) {
      return super.usage();
    }

    const allowedSpacing = this.opts.maxWidth - this.indentSpacing;
    return lines
      .map((line) => {
        const rest = line.slice(SANDBOX_NAME_PLACEHOLDER.length).trim();
        const full = `$ ${this.config.bin} ${SANDBOX_NAME_PLACEHOLDER} ${action}${rest ? ` ${rest}` : ""}`;
        if (full.length > allowedSpacing) {
          const splitIndex = full.slice(0, Math.max(0, allowedSpacing)).lastIndexOf(" ");
          return (
            full.slice(0, Math.max(0, splitIndex)) +
            "\n" +
            this.indent(this.wrap(full.slice(Math.max(0, splitIndex)), this.indentSpacing * 2))
          );
        }
        return this.wrap(full);
      })
      .join("\n");
  }
}

export class NemoClawHelp extends Help {
  protected CommandHelpClass = SandboxScopedCommandHelp;
}

export default NemoClawHelp;
