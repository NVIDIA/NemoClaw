// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isNonInteractiveSession } from "../core/non-interactive";
import { parseTrustedPrivateHosts } from "../security/trusted-private-endpoint";

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
  trustedPrivateHosts: readonly string[];
  commandTrustedPrivateHosts: readonly string[];
};

export type PolicyAddOptions = {
  preset?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  fromFile?: string;
  fromDir?: string;
  trustedPrivateHosts?: readonly string[];
};

export type PolicyRemoveOptions = {
  preset?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
};

export type PolicyBaselineOptions = {
  key?: string;
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
  stdinIsTty: boolean = Boolean(process.stdin.isTTY),
): ParsedPolicyAddOptions {
  const source = customPolicySourceFromOptions(options);
  const commandTrustedPrivateHosts = options.trustedPrivateHosts ?? [];
  const trustedPrivateHosts = [
    ...parseTrustedPrivateHosts(env.NEMOCLAW_TRUSTED_PRIVATE_HOSTS),
    ...commandTrustedPrivateHosts,
  ];
  const effectiveSource =
    source.kind === "none" && commandTrustedPrivateHosts.length > 0
      ? {
          kind: "error" as const,
          message: "--trusted-private-host requires --from-file or --from-dir.",
        }
      : source;
  return {
    dryRun: Boolean(options.dryRun),
    skipConfirm: Boolean(
      options.yes || options.force || isNonInteractiveSession(env as NodeJS.ProcessEnv, stdinIsTty),
    ),
    source: effectiveSource,
    presetArg: options.preset ?? null,
    trustedPrivateHosts,
    commandTrustedPrivateHosts,
  };
}
