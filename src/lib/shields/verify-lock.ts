// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-verify that the sandbox filesystem still matches what `shields up`
// established: 444 root:root on each locked file, the agent-specific
// locked ownership and mode on the config directory, no legacy state
// layout, and the immutable bit when the caller knows `chattr` was
// applied. When the caller supplies the
// SHA-256 seal that was captured at lock time, also re-hash each file
// and surface a content-drift entry on any mismatch. This catches the
// host-root tamper pattern that defeats perm-only verification: chmod
// to mutable -> write -> chmod back to 444 leaves mode/owner identical
// to the locked baseline but produces a new content hash.
//
// Returns the list of mismatches so callers can either fail the lock
// operation or surface drift after a host-root tamper. Stat/lsattr/hash
// failures are folded into `issues` so the caller can decide whether to
// treat them as drift.

import { parseSha256Output } from "./seal";

export type LockTarget = {
  agentName?: string;
  configPath: string;
  configDir: string;
  sensitiveFiles?: string[];
};

export type VerifyShieldsLockOptions = {
  verifyChattr?: boolean;
  exec: (cmd: string[]) => string;
  assertLegacyLayout?: (sandboxName: string, configDir: string) => void;
  expectedHashes?: { [path: string]: string };
  verifyParentProtection?: boolean;
};

export type VerifyShieldsLockResult = {
  ok: boolean;
  issues: string[];
};

const EXPECTED_FILE_MODE = "444";
const EXPECTED_DIR_MODE = "755";
const EXPECTED_OWNER = "root:root";
// Hermes writes its top-level runtime state inside the config root, so its
// locked root stays group-writable with set-id/sticky and only changes owner.
// The sticky bit is what stops the sandbox identity from unlinking the sealed
// root-owned files (#7865). A Hermes root still sitting at the pre-#7865
// `755 root:root` cannot run a gateway at all, so report it as drift and let
// the caller's re-lock repair it rather than passing it as a healthy lock.
const HERMES_EXPECTED_DIR_MODE = "3770";
const HERMES_EXPECTED_DIR_OWNER = "root:sandbox";

function expectedLockedDirPosture(agentName?: string): {
  mode: string;
  owner: string;
} {
  return agentName === "hermes"
    ? { mode: HERMES_EXPECTED_DIR_MODE, owner: HERMES_EXPECTED_DIR_OWNER }
    : { mode: EXPECTED_DIR_MODE, owner: EXPECTED_OWNER };
}

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
      if (owner !== EXPECTED_OWNER) issues.push(`${f} owner=${owner} (expected ${EXPECTED_OWNER})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${f} stat failed: ${msg}`);
    }
  }

  const expectedDir = expectedLockedDirPosture(target.agentName);
  try {
    const dirPerms = exec(["stat", "-c", "%a %U:%G", target.configDir]);
    const [dirMode, dirOwner] = dirPerms.split(" ");
    if (dirMode !== expectedDir.mode)
      issues.push(`dir mode=${dirMode} (expected ${expectedDir.mode})`);
    if (dirOwner !== expectedDir.owner)
      issues.push(`dir owner=${dirOwner} (expected ${expectedDir.owner})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    issues.push(`dir stat failed: ${msg}`);
  }

  if (
    options.verifyParentProtection &&
    (target.agentName === "hermes" ||
      target.agentName === "openclaw" ||
      target.agentName === "langchain-deepagents-code")
  ) {
    const separator = target.configDir.lastIndexOf("/");
    const parentDir = separator > 0 ? target.configDir.slice(0, separator) : "/";
    try {
      const parentPerms = exec(["stat", "-c", "%a %U:%G", parentDir]);
      const [parentMode, parentOwner] = parentPerms.split(" ");
      if (parentMode !== "1775") {
        issues.push(`parent dir mode=${parentMode} (expected 1775)`);
      }
      if (parentOwner !== "root:sandbox") {
        issues.push(`parent dir owner=${parentOwner} (expected root:sandbox)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`parent dir stat failed: ${msg}`);
    }
  }

  if (options.verifyChattr) {
    for (const f of filesToVerify) {
      try {
        const attrs = exec(["lsattr", "-d", f]);
        // lsattr format: "----i---------e----- /path/to/file"
        // First whitespace-delimited token is the flags field.
        const [flags] = attrs.trim().split(/\s+/, 1);
        if (!flags.includes("i")) issues.push(`${f} immutable bit not set`);
      } catch (err) {
        // Callers set verifyChattr only after `chattr +i` succeeded on this
        // image, so a failure here is drift rather than a missing tool.
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`${f} immutable bit unverified (lsattr failed: ${msg})`);
      }
    }
  }

  if (options.expectedHashes) {
    const expected = options.expectedHashes;
    for (const f of filesToVerify) {
      const want = expected[f];
      if (!want) {
        // Seal was missing for this file — flag explicitly rather than
        // silently passing. Callers that genuinely lack a seal pass
        // `expectedHashes: undefined` instead of an empty record.
        // Prefix with "content drifted" so callers that filter on that
        // substring (`shieldsUp` re-seal refusal) treat every hash-trust
        // failure as non-launderable.
        issues.push(`${f} content drifted (no seal recorded; expected SHA-256)`);
        continue;
      }
      let raw: string;
      try {
        raw = exec(["sha256sum", f]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        issues.push(`${f} content drifted (sha256sum failed: ${msg})`);
        continue;
      }
      const got = parseSha256Output(raw);
      if (!got) {
        issues.push(`${f} content drifted (sha256sum output unparsable: ${raw.trim()})`);
        continue;
      }
      if (got !== want.toLowerCase()) {
        issues.push(`${f} content drifted (sha256 ${got} != sealed ${want.toLowerCase()})`);
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
