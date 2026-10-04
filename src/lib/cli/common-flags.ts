// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";

export function yesFlag(description = "Skip the confirmation prompt") {
  return Flags.boolean({ char: "y", description });
}

export function forceFlag(description = "Skip the confirmation prompt") {
  return Flags.boolean({ description });
}

export function dryRunFlag(description = "Preview without applying") {
  return Flags.boolean({ description });
}

export function jsonFlag(description = "Print output as JSON") {
  return Flags.boolean({ description });
}

export function quietFlag(description = "Suppress non-essential stderr output") {
  return Flags.boolean({ char: "q", description });
}
