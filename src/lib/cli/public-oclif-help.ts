// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CommandHelp } from "@oclif/core";

import { CLI_NAME } from "../branding";
import { getRegisteredOclifCommandMetadata, type OclifCommandMetadata } from "./oclif-metadata";

type PublicHelpCommand = OclifCommandMetadata & {
  aliases?: string[];
  examples?: string[];
  flags: Record<string, unknown>;
  hiddenAliases?: string[];
  id: string;
};

class PublicUsageCommandHelp extends CommandHelp {
  public constructor(command: PublicHelpCommand, publicUsage: string) {
    super(
      command as never,
      {
        bin: CLI_NAME,
        platform: process.platform,
        shell: process.env.SHELL ?? "",
        theme: undefined,
      } as never,
      { flagSortOrder: "none" } as never,
    );
    this.publicUsage = publicUsage;
  }

  private readonly publicUsage: string;

  protected override usage(): string {
    return `$ ${CLI_NAME} ${this.publicUsage}`;
  }
}

function toPublicHelpCommand(
  commandId: string,
  metadata: OclifCommandMetadata,
): PublicHelpCommand {
  return {
    ...metadata,
    aliases: [],
    args: metadata.args ?? {},
    flags: {
      ...(metadata.baseFlags ?? {}),
      ...(metadata.flags ?? {}),
    },
    hiddenAliases: [],
    id: metadata.id ?? commandId,
    strict: metadata.strict ?? true,
  };
}

export function renderPublicOclifHelp(commandId: string, publicUsage: string): void {
  const metadata = getRegisteredOclifCommandMetadata(commandId);
  if (!metadata) {
    console.log(`\n  Usage: ${CLI_NAME} ${publicUsage}`);
    return;
  }

  console.log(new PublicUsageCommandHelp(toPublicHelpCommand(commandId, metadata), publicUsage).generate());
}
