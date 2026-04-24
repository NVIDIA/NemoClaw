// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sandbox backup and restore functionality

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import * as registry from "./registry.js";
import { ROOT } from "./runner.js";

export const BACKUP_DIR = path.join(process.env.HOME || "/tmp", ".nemoclaw", "backups");

const SANDBOX_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function isValidSandboxName(name: string): boolean {
  return SANDBOX_NAME_PATTERN.test(name);
}

function runOpenshell(args: string[]) {
  const result = spawnSync("openshell", args, {
    encoding: "utf-8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Ensures the backup directory exists with appropriate permissions.
 */
export function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

export interface BackupEntry {
  name: string;
  createdAt: string;
  path: string;
  size: number;
}

/**
 * Lists all sandbox backups in the backup directory.
 * @returns {BackupEntry[]}
 */
export function listBackups(): BackupEntry[] {
  ensureBackupDir();
  if (!fs.existsSync(BACKUP_DIR)) return [];

  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json"));
  const backups: BackupEntry[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(BACKUP_DIR, file);
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!content.metadata || !content.metadata.name || !content.metadata.createdAt) {
        console.warn(`  Warning: Skipping malformed backup ${file}: missing metadata`);
        continue;
      }
      backups.push({
        name: content.metadata.name,
        createdAt: content.metadata.createdAt,
        path: filePath,
        size: fs.statSync(filePath).size,
      });
    } catch (err: any) {
      console.warn(`  Warning: Could not read backup ${file}: ${err.message}`);
    }
  }

  return backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/**
 * Exports a sandbox to a backup file.
 * @param {string} sandboxName - Name of the sandbox to export.
 * @param {string} [outputPath] - Optional output path for the backup file.
 * @returns {string|null} Path to the created backup file, or null if sandbox not found.
 */
export function exportSandbox(sandboxName: string, outputPath?: string): string | null {
  const sandbox = registry.getSandbox(sandboxName);
  if (!sandbox) {
    console.error(`  Sandbox not found: ${sandboxName}`);
    return null;
  }

  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultName = `${sandboxName}-${timestamp}.json`;
  const backupPath = outputPath || path.join(BACKUP_DIR, defaultName);

  const policyResult = runOpenshell(["policy", "get", sandboxName]);
  const policyContent = policyResult.status === 0 ? policyResult.stdout : "";

  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
  } catch {
    // ignore
  }

  const backup = {
    version: "1.0",
    metadata: {
      name: sandboxName,
      createdAt: new Date().toISOString(),
      nemoclawVersion: version,
    },
    sandbox: {
      name: sandbox.name,
      model: sandbox.model,
      provider: sandbox.provider,
      gpuEnabled: sandbox.gpuEnabled,
      policies: sandbox.policies || [],
    },
    policy: policyContent,
  };

  const dir = path.dirname(backupPath);
  if (dir !== BACKUP_DIR) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), { mode: 0o600 });
  console.log(`  Exported sandbox '${sandboxName}' to: ${backupPath}`);

  return backupPath;
}

/**
 * Imports a sandbox from a backup file.
 * @param {string} backupPath - Path to the backup file.
 * @param {string} [newName] - Optional new name for the imported sandbox.
 * @returns {Promise<boolean>} True if import succeeded, false otherwise.
 */
export async function importSandbox(backupPath: string, newName?: string): Promise<boolean> {
  if (!fs.existsSync(backupPath)) {
    console.error(`  Backup file not found: ${backupPath}`);
    return false;
  }

  let backup: any;
  try {
    backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
  } catch {
    console.error(`  Invalid backup file: ${backupPath}`);
    return false;
  }

  if (!backup.version || !backup.sandbox) {
    console.error("  Invalid backup format");
    return false;
  }

  const sandboxName = newName || backup.sandbox.name;

  if (!isValidSandboxName(sandboxName)) {
    console.error(`  Invalid sandbox name: ${sandboxName}`);
    return false;
  }

  console.log(`  Creating sandbox '${sandboxName}' from backup...`);

  const existsResult = runOpenshell(["sandbox", "exists", sandboxName]);
  if (existsResult.status === 0) {
    console.error(`  Sandbox '${sandboxName}' already exists. Use a different name or delete it first.`);
    return false;
  }

  console.log(`  Note: This only imports the registry config.`);
  console.log(`  You need to manually recreate the sandbox and apply policies.`);

  registry.registerSandbox({
    name: sandboxName,
    model: backup.sandbox.model,
    provider: backup.sandbox.provider,
    gpuEnabled: backup.sandbox.gpuEnabled,
    policies: backup.sandbox.policies || [],
  });

  if (backup.policy) {
    const policyPath = path.join(os.tmpdir(), `nemoclaw-restore-${Date.now()}.yaml`);
    fs.writeFileSync(policyPath, backup.policy);
    try {
      const policyResult = runOpenshell(["policy", "set", "--policy", policyPath, "--wait", sandboxName]);
      if (policyResult.status === 0) {
        console.log(`  Restored policy for '${sandboxName}'`);
      } else {
        console.warn(`  Warning: Could not restore policy: ${policyResult.stderr}`);
      }
    } catch (err: any) {
      console.warn(`  Warning: Could not restore policy: ${err.message}`);
    } finally {
      try { fs.unlinkSync(policyPath); } catch { /* ignore */ }
    }
  }

  console.log(`  Imported sandbox '${sandboxName}' from backup`);
  return true;
}

/**
 * Deletes a backup file.
 * @param {string} backupPath - Path to the backup file to delete.
 * @returns {boolean} True if deletion succeeded, false otherwise.
 */
export function deleteBackup(backupPath: string): boolean {
  if (!fs.existsSync(backupPath)) {
    console.error(`  Backup not found: ${backupPath}`);
    return false;
  }
  fs.unlinkSync(backupPath);
  console.log(`  Deleted backup: ${backupPath}`);
  return true;
}
