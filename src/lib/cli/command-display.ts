// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CommandGroup =
  | "Getting Started"
  | "Sandbox Management"
  | "Skills"
  | "Policy Presets"
  | "Messaging Channels"
  | "Compatibility Commands"
  | "Services"
  | "Troubleshooting"
  | "Credentials"
  | "Backup"
  | "Upgrade"
  | "Cleanup";

export interface CommandDisplayEntry {
  /** Canonical command signature, e.g. "nemoclaw <name> snapshot create" */
  usage: string;
  /** One-line description for help output */
  description: string;
  /** Optional flag syntax, e.g. "[--name <label>]" */
  flags?: string;
  /** Section header in help output */
  group: CommandGroup;
  /** Deprecated commands show dimmed in help */
  deprecated?: boolean;
  /** Hidden commands are excluded from help and canonical list but included in dispatch */
  hidden?: boolean;
  /** Whether this command is global or sandbox-scoped */
  scope: "global" | "sandbox";
  /** Stable display order used when rendering grouped root help. */
  order: number;
}

export type CommandDisplayClass<T> = T & {
  display?: readonly CommandDisplayEntry[];
};

export function withCommandDisplay<T>(
  commandClass: T,
  display: readonly CommandDisplayEntry[],
): CommandDisplayClass<T> {
  (commandClass as CommandDisplayClass<T>).display = display;
  return commandClass as CommandDisplayClass<T>;
}
