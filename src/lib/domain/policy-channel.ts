// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type CustomPolicySource =
  | { kind: "none" }
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string }
  | { kind: "error"; message: string };

export type ParsedPolicyAddOptions = {
  dryRun: boolean;
  skipConfirm: boolean;
  source: CustomPolicySource;
  presetArg: string | null;
};

export type PolicyAddOptions = {
  preset?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  fromFile?: string;
  fromDir?: string;
};

export type PolicyRemoveOptions = {
  preset?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
};

function customPolicySourceFromOptions(options: PolicyAddOptions): CustomPolicySource {
  if (options.fromFile !== undefined && options.fromDir !== undefined) {
    return { kind: "error", message: "--from-file and --from-dir are mutually exclusive." };
  }

  if (options.fromFile !== undefined) {
    if (!options.fromFile) {
      return { kind: "error", message: "--from-file requires a path argument." };
    }
    return { kind: "file", path: options.fromFile };
  }

  if (options.fromDir !== undefined) {
    if (!options.fromDir) {
      return { kind: "error", message: "--from-dir requires a directory path." };
    }
    return { kind: "dir", path: options.fromDir };
  }

  return { kind: "none" };
}

export function parsePolicyAddOptions(
  options: PolicyAddOptions = {},
  env: Record<string, string | undefined> = process.env,
): ParsedPolicyAddOptions {
  return {
    dryRun: Boolean(options.dryRun),
    skipConfirm: Boolean(options.yes || options.force || env.NEMOCLAW_NON_INTERACTIVE === "1"),
    source: customPolicySourceFromOptions(options),
    presetArg: options.preset ?? null,
  };
}
