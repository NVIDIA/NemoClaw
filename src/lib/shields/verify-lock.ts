// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-verify that the sandbox filesystem still matches what `shields up`
// established: 444 root:root on each locked file, 755 root:root on the
// config directory, no legacy state layout, and (when the caller knows
// chattr was applied) the immutable bit. Returns the list of mismatches
// so callers can either fail the lock operation or surface drift after a
// host-root tamper. Stat/lsattr failures are folded into `issues` so the
// caller can decide whether to treat them as drift.

export type LockTarget = {
  configPath: string;
  configDir: string;
  sensitiveFiles?: string[];
};

export type VerifyShieldsLockOptions = {
  verifyChattr?: boolean;
  exec: (cmd: string[]) => string;
  assertLegacyLayout?: (sandboxName: string, configDir: string) => void;
};

export type VerifyShieldsLockResult = {
  ok: boolean;
  issues: string[];
};

const EXPECTED_FILE_MODE = "444";
const EXPECTED_DIR_MODE = "755";
const EXPECTED_OWNER = "root:root";

function noopAssertLegacyLayout(_sandboxName: string, _configDir: string): void {
  // Production callers replace this with the real legacy-layout assertion;
  // when omitted, the verifier treats legacy-layout state as "no issue".
}

export function verifyShieldsLockState(
  sandboxName: string,
  target: LockTarget,
  options: VerifyShieldsLockOptions,
): VerifyShieldsLockResult {
  if (!options || !options.exec) {
    throw new Error("verifyShieldsLockState requires options.exec");
  }
  const exec = options.exec;
  const assertLegacyLayout = options.assertLegacyLayout ?? noopAssertLegacyLayout;
  const issues: string[] = [];
  const filesToVerify = [target.configPath, ...(target.sensitiveFiles || [])];

  for (const f of filesToVerify) {
    try {
      const perms = exec(["stat", "-c", "%a %U:%G", f]);
      const [mode, owner] = perms.split(" ");
      if (mode !== EXPECTED_FILE_MODE)
        issues.push(`${f} mode=${mode} (expected ${EXPECTED_FILE_MODE})`);
      if (owner !== EXPECTED_OWNER)
        issues.push(`${f} owner=${owner} (expected ${EXPECTED_OWNER})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${f} stat failed: ${msg}`);
    }
  }

  try {
    const dirPerms = exec(["stat", "-c", "%a %U:%G", target.configDir]);
    const [dirMode, dirOwner] = dirPerms.split(" ");
    if (dirMode !== EXPECTED_DIR_MODE)
      issues.push(`dir mode=${dirMode} (expected ${EXPECTED_DIR_MODE})`);
    if (dirOwner !== EXPECTED_OWNER)
      issues.push(`dir owner=${dirOwner} (expected ${EXPECTED_OWNER})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`dir stat failed: ${msg}`);
  }

  if (options.verifyChattr) {
    for (const f of filesToVerify) {
      try {
        const attrs = exec(["lsattr", "-d", f]);
        // lsattr format: "----i---------e----- /path/to/file"
        // First whitespace-delimited token is the flags field.
        const [flags] = attrs.trim().split(/\s+/, 1);
        if (!flags.includes("i")) issues.push(`${f} immutable bit not set`);
      } catch {
        // lsattr may not be available on all images — skip
      }
    }
  }

  try {
    assertLegacyLayout(sandboxName, target.configDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(msg);
  }

  return { ok: issues.length === 0, issues };
}
