// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Mutable-config permission repair / diagnostics (#4538)
//
// OpenClaw's `openclaw doctor --fix` enforces a single-user 700/600 state
// layout. NemoClaw's mutable contract is the opposite: the gateway UID shares
// the `sandbox` group (Dockerfile.base `usermod -aG sandbox gateway`), so
// /sandbox/.openclaw must stay setgid + group-writable (2770) and openclaw.json
// group-writable (660) or control-UI config writes EACCES against the gateway
// UID. `doctor --fix` — run manually inside the sandbox, or by NemoClaw's own
// rebuild structure-repair step — silently tightens these back to 700/600.
//
// This module holds the pure contract-checking logic plus the inspect/repair
// orchestration, parameterized over the privileged sandbox operations so it can
// be unit-tested without a live sandbox. The sandbox-bound wrappers live in
// ./index.ts.

// #4538 describes the user-expected contract as 2775/664. NemoClaw uses
// 2770/660 because the gateway shares the sandbox group; dropping the "other"
// bit keeps writes accessible to (sandbox UID, gateway UID) only and matches
// the pre-doctor state baked into the sandbox image.
export const MUTABLE_OPENCLAW_DIR_MODE = "2770";
export const MUTABLE_OPENCLAW_FILE_MODE = "660";
export const MUTABLE_OPENCLAW_OWNER = "sandbox:sandbox";

export type MutableConfigPostureMode =
  | "mutable_default"
  | "locked"
  | "temporarily_unlocked"
  | "error";

export interface MutableConfigTarget {
  agentName: string;
  configDir: string;
  configPath: string;
  configFile: string;
  // Files re-permissioned alongside the main config by unlockAgentConfig
  // (e.g. .config-hash, .env). Listed here so inspect surfaces drift on the
  // same set that repair will touch — otherwise the user-facing "Config
  // permissions" check would silently underreport.
  sensitiveFiles?: string[];
}

export type MutableConfigPermsInspection =
  | { applies: false; reason: string }
  | {
      applies: true;
      ok: boolean;
      dirMode: string;
      dirOwner: string;
      fileMode: string;
      fileOwner: string;
      configDir: string;
      configFile: string;
      issues: string[];
    };

// Why a repair was not applied:
//   "agent"      — not an OpenClaw sandbox (contract does not apply)
//   "locked"     — shields up; config is intentionally root-owned/locked (benign)
//   "unreadable" — shields state is corrupt; posture unknown, so we refused to
//                  touch permissions. The contract may still be broken — callers
//                  must NOT treat this as benign.
export type MutableConfigSkipReason = "agent" | "locked" | "unreadable";

export type MutableConfigRepairResult =
  | { applied: false; skipReason: MutableConfigSkipReason; reason: string }
  | { applied: true; verified: boolean; errors: string[] };

export function parseStatModeOwner(raw: string): { mode: string; owner: string } {
  const [mode, owner] = raw.trim().split(/\s+/);
  return { mode: mode || "", owner: owner || "" };
}

// stat %a renders the octal mode, including the setuid/setgid/sticky bits when
// set (e.g. "2770", "770", "700"). Pad to 4 digits and require an exact match
// against the contract: anything else — a tightened owner class (2670), dropped
// setgid (770), or widened world bits (2777) — is a drift worth flagging, since
// `repairMutableConfigPerms` restores exactly 2770/660 anyway. Checking only
// selected group bits would let owner-broken and world-writable modes pass.
export function dirSatisfiesMutableContract(mode: string): boolean {
  return (
    /^[0-7]{3,4}$/.test(mode) &&
    mode.padStart(4, "0") === MUTABLE_OPENCLAW_DIR_MODE.padStart(4, "0")
  );
}

export function fileSatisfiesMutableContract(mode: string): boolean {
  return (
    /^[0-7]{3,4}$/.test(mode) &&
    mode.padStart(4, "0") === MUTABLE_OPENCLAW_FILE_MODE.padStart(4, "0")
  );
}

function postureBlocksMutableRepair(mode: MutableConfigPostureMode): string | null {
  if (mode === "locked") {
    return "shields are up (config is locked); refusing to weaken permissions";
  }
  if (mode === "error") {
    return "shields state unreadable; refusing to modify permissions";
  }
  return null;
}

/**
 * Inspect the OpenClaw mutable config directory and file permissions and report
 * whether the NemoClaw mutable contract (setgid + group-writable dir, group-
 * writable file) still holds. Returns `applies: false` for non-OpenClaw agents,
 * for shields-up/corrupt sandboxes (where root-owned 444 is intentional), and
 * when the config cannot be stat'd (e.g. the container is not running).
 */
export function inspectMutableConfigPerms(
  target: MutableConfigTarget,
  postureMode: MutableConfigPostureMode,
  statModeOwner: (path: string) => string,
): MutableConfigPermsInspection {
  if (target.agentName !== "openclaw") {
    return {
      applies: false,
      reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
    };
  }
  const blocked = postureBlocksMutableRepair(postureMode);
  if (blocked) {
    return {
      applies: false,
      reason:
        postureMode === "locked"
          ? "shields up (config intentionally locked)"
          : "shields state unreadable",
    };
  }
  let dir: { mode: string; owner: string };
  let file: { mode: string; owner: string };
  try {
    dir = parseStatModeOwner(statModeOwner(target.configDir));
    file = parseStatModeOwner(statModeOwner(target.configPath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applies: false, reason: `could not stat config (${message})` };
  }
  const issues: string[] = [];
  if (!dirSatisfiesMutableContract(dir.mode)) {
    issues.push(
      `${target.configDir} mode ${dir.mode} (expected ${MUTABLE_OPENCLAW_DIR_MODE} setgid+group-writable)`,
    );
  }
  if (dir.owner !== MUTABLE_OPENCLAW_OWNER) {
    issues.push(`${target.configDir} owner ${dir.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
  }
  if (!fileSatisfiesMutableContract(file.mode)) {
    issues.push(
      `${target.configFile} mode ${file.mode} (expected ${MUTABLE_OPENCLAW_FILE_MODE} group-writable)`,
    );
  }
  if (file.owner !== MUTABLE_OPENCLAW_OWNER) {
    issues.push(`${target.configFile} owner ${file.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
  }
  // Mirror the file contract over the sensitive-file set that unlockAgentConfig
  // touches. Missing files are tolerated (e.g. .config-hash is only created
  // after the first shields-up cycle); we only flag actual drift.
  for (const sensitivePath of target.sensitiveFiles || []) {
    let sensitive: { mode: string; owner: string };
    try {
      sensitive = parseStatModeOwner(statModeOwner(sensitivePath));
    } catch {
      continue;
    }
    if (!fileSatisfiesMutableContract(sensitive.mode)) {
      issues.push(
        `${sensitivePath} mode ${sensitive.mode} (expected ${MUTABLE_OPENCLAW_FILE_MODE} group-writable)`,
      );
    }
    if (sensitive.owner !== MUTABLE_OPENCLAW_OWNER) {
      issues.push(`${sensitivePath} owner ${sensitive.owner} (expected ${MUTABLE_OPENCLAW_OWNER})`);
    }
  }
  return {
    applies: true,
    ok: issues.length === 0,
    dirMode: dir.mode,
    dirOwner: dir.owner,
    fileMode: file.mode,
    fileOwner: file.owner,
    configDir: target.configDir,
    configFile: target.configFile,
    issues,
  };
}

/**
 * Restore the OpenClaw mutable config permission contract. No-op for non-
 * OpenClaw agents and for shields-up/corrupt sandboxes (where weakening the
 * lock would be a regression). `applyMutableContract` performs the privileged
 * chown/chmod (in ./index.ts this delegates to unlockAgentConfig so the applied
 * modes/ownership match the shields-down path) and throws if it cannot verify
 * the result.
 */
export function repairMutableConfigPerms(
  target: MutableConfigTarget,
  postureMode: MutableConfigPostureMode,
  applyMutableContract: () => void,
): MutableConfigRepairResult {
  if (target.agentName !== "openclaw") {
    return {
      applied: false,
      skipReason: "agent",
      reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
    };
  }
  if (postureMode === "locked") {
    return {
      applied: false,
      skipReason: "locked",
      reason: "shields are up (config is locked); refusing to weaken permissions",
    };
  }
  if (postureMode === "error") {
    return {
      applied: false,
      skipReason: "unreadable",
      reason: "shields state unreadable; refusing to modify permissions",
    };
  }
  try {
    applyMutableContract();
    return { applied: true, verified: true, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: true, verified: false, errors: [message] };
  }
}
