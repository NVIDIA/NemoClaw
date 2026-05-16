// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  npmGlobalBin,
  npmLinkTargetsWritable,
  pathWithPrependedEntries,
  type NpmLinkTargetState,
  type NpmLinkTargetWritableResult,
} from "../../domain/installer/npm";
import {
  installerProviderHelpValues,
  normalizeInstallerProvider,
  type InstallerProvider,
} from "../../domain/installer/provider";
import { resolveInstallerVersion, resolveInstallRef, type InstallerRefEnv } from "../../domain/installer/ref";
import { checkInstallerRuntime, type RuntimeCheckResult } from "../../domain/installer/version";

export interface InstallerPlanEnv extends InstallerRefEnv {
  NEMOCLAW_PROVIDER?: string | undefined;
  PATH?: string | undefined;
}

export interface BuildInstallerPlanOptions {
  defaultVersion?: string;
  env?: InstallerPlanEnv;
  gitDescribeVersion?: string | null;
  nodeVersion?: string | null;
  npmPrefix?: string | null;
  npmTargetState?: NpmLinkTargetState;
  npmVersion?: string | null;
  packageJsonVersion?: string | null;
  stampedVersion?: string | null;
}

export interface InstallerProviderPlan {
  helpValues: string;
  normalized: InstallerProvider | null;
  raw: string | null;
  valid: boolean;
}

export interface InstallerNpmPlan {
  globalBin: string | null;
  linkTargetsWritable: NpmLinkTargetWritableResult | null;
  pathWithGlobalBin: string | null;
  prefix: string;
}

export interface InstallerPlan {
  installRef: string;
  installerVersion: string;
  npm: InstallerNpmPlan | null;
  provider: InstallerProviderPlan;
  runtime: RuntimeCheckResult | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildInstallerPlan(options: BuildInstallerPlanOptions = {}): InstallerPlan {
  const env = options.env ?? {};
  const installRef = resolveInstallRef(env);
  const providerRaw = nonEmpty(env.NEMOCLAW_PROVIDER);
  const normalizedProvider = normalizeInstallerProvider(providerRaw);
  const globalBin = options.npmPrefix ? npmGlobalBin(options.npmPrefix) : null;

  return {
    installRef,
    installerVersion: resolveInstallerVersion({
      defaultVersion: options.defaultVersion ?? "0.1.0",
      env,
      gitDescribeVersion: options.gitDescribeVersion,
      packageJsonVersion: options.packageJsonVersion,
      stampedVersion: options.stampedVersion,
    }),
    npm: options.npmPrefix
      ? {
          globalBin,
          linkTargetsWritable: options.npmTargetState
            ? npmLinkTargetsWritable(options.npmPrefix, options.npmTargetState)
            : null,
          pathWithGlobalBin: globalBin ? pathWithPrependedEntries(env.PATH ?? "", [globalBin]) : null,
          prefix: options.npmPrefix.trim(),
        }
      : null,
    provider: {
      helpValues: installerProviderHelpValues(),
      normalized: normalizedProvider,
      raw: providerRaw,
      valid: providerRaw === null || normalizedProvider !== null,
    },
    runtime:
      options.nodeVersion && options.npmVersion
        ? checkInstallerRuntime({ nodeVersion: options.nodeVersion, npmVersion: options.npmVersion })
        : null,
  };
}

export function normalizeInstallerEnv(env: InstallerPlanEnv): Pick<InstallerPlan, "installRef" | "provider"> {
  const plan = buildInstallerPlan({ env });
  return { installRef: plan.installRef, provider: plan.provider };
}
