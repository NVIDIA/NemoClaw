// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Command } from "@oclif/core";

type OclifCommandClass = {
  flags?: Record<string, unknown>;
};

export function extendsNemoClawCommand(
  commandClass: unknown,
  nemoClawCommandBase: unknown,
): boolean {
  if (typeof commandClass !== "function") return false;
  let current = Object.getPrototypeOf(commandClass) as object | null;
  while (current) {
    if (current === nemoClawCommandBase) return true;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

export function commandOwnsHelpFlag(commandClass: unknown): boolean {
  return (
    typeof commandClass === "function" &&
    Object.hasOwn((commandClass as OclifCommandClass).flags ?? {}, "help")
  );
}

export async function findCommandsOutsideNemoClawBase(
  commands: readonly Command.Loadable[],
  nemoClawCommandBase: unknown,
): Promise<string[]> {
  const nonConforming: string[] = [];
  for (const command of commands) {
    const commandClass = await command.load();
    if (!extendsNemoClawCommand(commandClass, nemoClawCommandBase)) nonConforming.push(command.id);
  }
  return nonConforming;
}

export async function findCommandsOwningHelpFlag(
  commands: readonly Command.Loadable[],
): Promise<string[]> {
  const duplicatedHelpFlags: string[] = [];
  for (const command of commands) {
    const commandClass = await command.load();
    if (commandOwnsHelpFlag(commandClass)) duplicatedHelpFlags.push(command.id);
  }
  return duplicatedHelpFlags;
}

export function findMissingPublicCommandStatics(commands: readonly Command.Loadable[]): string[] {
  const missing: string[] = [];
  for (const command of commands.filter((candidate) => candidate.hidden !== true)) {
    if (!command.summary) missing.push(`${command.id}: summary`);
    if (!command.description) missing.push(`${command.id}: description`);
    const hasUsage =
      (typeof command.usage === "string" && command.usage.length > 0) ||
      (Array.isArray(command.usage) && command.usage.length > 0);
    if (!hasUsage) {
      missing.push(`${command.id}: usage`);
    }
    if (!Array.isArray(command.examples) || command.examples.length === 0) {
      missing.push(`${command.id}: examples`);
    }
  }
  return missing;
}
