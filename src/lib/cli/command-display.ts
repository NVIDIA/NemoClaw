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

/**
 * Public sandbox-first display metadata for root help and docs checks.
 *
 * Keep oclif-native parser metadata (`summary`, `description`, `usage`,
 * `flags`, `args`) on the command class itself. Use `static publicDisplay`
 * only when the public NemoClaw grammar differs from the oclif-native command
 * shape or when a command needs root-help grouping/order metadata. Runtime
 * routing must use machine-readable public route metadata, not these display
 * strings.
 */
export interface PublicCommandDisplayEntry {
  /** Canonical public command signature, e.g. "nemoclaw <name> snapshot create" */
  usage: string;
  /** One-line description for public help output */
  description: string;
  /** Optional public flag syntax, e.g. "[--name <label>]" */
  flags?: string;
  /** Section header in public help output */
  group: CommandGroup;
  /** Deprecated commands show dimmed in public help */
  deprecated?: boolean;
  /** Hidden commands are excluded from help and canonical list but included in dispatch */
  hidden?: boolean;
  /** Whether this public command is global or sandbox-scoped */
  scope: "global" | "sandbox";
  /** Stable display order used when rendering grouped root help. */
  order: number;
}
