// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "./branding";
import { getRegisteredOclifCommandMetadata } from "./oclif-metadata";

export function renderPublicOclifHelp(commandId: string, publicUsage: string): void {
  const metadata = getRegisteredOclifCommandMetadata(commandId);
  const lines = ["", `  Usage: ${CLI_NAME} ${publicUsage}`];

  if (metadata?.summary || metadata?.description) {
    lines.push("");
    if (metadata.summary) {
      lines.push(`  ${metadata.summary}`);
    }
    if (metadata.description && metadata.description !== metadata.summary) {
      lines.push(`  ${metadata.description}`);
    }
  }

  if (metadata?.examples?.length) {
    lines.push("");
    lines.push("  Examples:");
    for (const example of metadata.examples) {
      lines.push(`    ${example.replace(/<%= config\.bin %>/g, CLI_NAME)}`);
    }
  }

  console.log(lines.join("\n"));
}
