// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "./branding";

export function inferenceSetRequiredFlagsFailureLines(command: string, usageSuffix = ""): string[] {
  const displayCommand = `${CLI_NAME} ${command}`;
  return [
    `  ${displayCommand} requires --provider and --model.`,
    "",
    `  Run: ${displayCommand} --provider <provider> --model <model>${usageSuffix}`,
    "  NemoClaw must perform this operation so it can protect every sandbox sharing the target gateway.",
    "",
    `  Run '${CLI_NAME} help' for NemoClaw commands.`,
  ];
}
