// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Config as OclifConfig } from "@oclif/core";

import { CLI_NAME } from "./branding";

export interface OclifCommandRunOptions {
  rootDir: string;
  error?: (message?: string) => void;
  exit?: (code: number) => never;
}

function getOclifExitCode(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const oclif = (error as { oclif?: { exit?: number } }).oclif;
  return typeof oclif?.exit === "number" ? oclif.exit : null;
}

function isOclifParseError(error: unknown): boolean {
  const name =
    error && typeof error === "object"
      ? (error as { constructor?: { name?: string } }).constructor?.name
      : "";
  return name === "NonExistentFlagsError" || name === "UnexpectedArgsError" || name === "CLIError";
}

function formatOclifError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim();
  }

  return String(error).trim();
}

function applyBrandedBin(config: OclifConfig): void {
  const pjson = {
    ...config.pjson,
    oclif: {
      ...config.pjson.oclif,
      bin: CLI_NAME,
    },
  };
  // config.runCommand() calls Command.run(), which reloads from the root
  // plugin. Patch both config and root plugin metadata so alias launchers keep
  // branded oclif help output.
  config.bin = CLI_NAME;
  config.pjson = pjson;
  config.options.pjson = pjson;
  for (const plugin of config.plugins.values()) {
    if (plugin.root === config.root) {
      plugin.pjson = pjson;
      plugin.options.pjson = pjson;
    }
  }
}

export async function runRegisteredOclifCommand(
  commandId: string,
  args: string[],
  opts: OclifCommandRunOptions,
): Promise<void> {
  const config = await OclifConfig.load(opts.rootDir);
  applyBrandedBin(config);
  const errorLine = opts.error ?? console.error;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  try {
    await config.runCommand(commandId, args);
  } catch (error) {
    const exitCode = getOclifExitCode(error);
    if (exitCode === 0) {
      process.exitCode = 0;
      return;
    }

    if (isOclifParseError(error)) {
      errorLine(`  ${formatOclifError(error)}`);
      exit(exitCode ?? 1);
    }

    throw error;
  }
}
