// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface InstallerRefEnv {
  NEMOCLAW_INSTALL_REF?: string | undefined;
  NEMOCLAW_INSTALL_TAG?: string | undefined;
}

export function resolveInstallRef(env: InstallerRefEnv): string {
  const explicitRef = env.NEMOCLAW_INSTALL_REF?.trim();
  if (explicitRef) return explicitRef;
  const tag = env.NEMOCLAW_INSTALL_TAG?.trim();
  return tag || "latest";
}

export function installerVersionFromRef(ref: string, fallbackVersion: string): string | null {
  const normalized = ref.trim();
  if (!normalized || normalized === "latest") return null;
  return normalized.replace(/^v/, "") || fallbackVersion;
}

export function resolveInstallerVersion(input: {
  defaultVersion: string;
  env?: InstallerRefEnv;
  gitDescribeVersion?: string | null;
  packageJsonVersion?: string | null;
  stampedVersion?: string | null;
}): string {
  const ref = input.env ? resolveInstallRef(input.env) : "latest";
  const refVersion = installerVersionFromRef(ref, input.defaultVersion);
  if (refVersion) return refVersion;

  for (const candidate of [input.gitDescribeVersion, input.stampedVersion, input.packageJsonVersion]) {
    const version = candidate?.trim().replace(/^v/, "");
    if (version) return version;
  }
  return input.defaultVersion;
}
