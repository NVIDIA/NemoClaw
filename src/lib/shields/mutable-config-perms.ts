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

export const MUTABLE_OPENCLAW_DIR_MODE = "2770";
export const MUTABLE_OPENCLAW_FILE_MODE = "660";

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

export type MutableConfigRepairResult =
  | { applied: false; reason: string }
  | { applied: true; verified: boolean; errors: string[] };

export function parseStatModeOwner(raw: string): { mode: string; owner: string } {
  const [mode, owner] = raw.trim().split(/\s+/);
  return { mode: mode || "", owner: owner || "" };
}

// stat %a renders the octal mode, including the setuid/setgid/sticky bits when
// set (e.g. "2770", "770", "700"). Pad to 4 digits so the special-bit nibble is
// always index 0 and the group nibble is always index 2.
export function dirSatisfiesMutableContract(mode: string): boolean {
  if (!/^[0-7]{3,4}$/.test(mode)) return false;
  const padded = mode.padStart(4, "0");
  const setgid = (Number.parseInt(padded[0], 8) & 0o2) !== 0;
  const group = Number.parseInt(padded[2], 8);
  // The gateway UID needs group read/write/execute to traverse the directory
  // and create entries; setgid keeps new files owned by the sandbox group.
  return setgid && group === 0o7;
}

export function fileSatisfiesMutableContract(mode: string): boolean {
  if (!/^[0-7]{3,4}$/.test(mode)) return false;
  const padded = mode.padStart(4, "0");
  const group = Number.parseInt(padded[2], 8);
  // Group read+write so the gateway UID can persist runtime config edits.
  return (group & 0o6) === 0o6;
}

function postureBlocksMutableRepair(
  mode: MutableConfigPostureMode,
): string | null {
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
  if (!fileSatisfiesMutableContract(file.mode)) {
    issues.push(
      `${target.configFile} mode ${file.mode} (expected ${MUTABLE_OPENCLAW_FILE_MODE} group-writable)`,
    );
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
      reason: `agent ${target.agentName} does not use the mutable OpenClaw config contract`,
    };
  }
  const blocked = postureBlocksMutableRepair(postureMode);
  if (blocked) {
    return { applied: false, reason: blocked };
  }
  try {
    applyMutableContract();
    return { applied: true, verified: true, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { applied: true, verified: false, errors: [message] };
  }
}
