// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isObjectRecord } from "../shared/object-record.js";

let configDir = join(homedir(), ".nemoclaw");

/** NemoClaw metadata only; native OpenClaw configuration owns inference. */
export interface NemoClawOnboardConfig {
  profile: string;
  onboardedAt: string;
}

function isOnboardConfig(value: unknown): value is NemoClawOnboardConfig {
  return (
    isObjectRecord(value) &&
    typeof value.profile === "string" &&
    typeof value.onboardedAt === "string"
  );
}

let configDirCreated = false;

function ensureConfigDir(): void {
  if (configDirCreated) return;
  if (!existsSync(configDir)) {
    try {
      mkdirSync(configDir, { recursive: true });
    } catch {
      configDir = mkdtempSync(join(tmpdir(), "nemoclaw-config-"));
    }
  }
  configDirCreated = true;
}

function configPath(): string {
  return join(configDir, "config.json");
}

export function loadOnboardConfig(): NemoClawOnboardConfig | null {
  ensureConfigDir();
  const path = configPath();
  if (!existsSync(path)) {
    return null;
  }
  // Treat unreadable config as "no config" so plugin register doesn't abort.
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isOnboardConfig(parsed)
      ? { profile: parsed.profile, onboardedAt: parsed.onboardedAt }
      : null;
  } catch {
    return null;
  }
}

export function saveOnboardConfig(config: NemoClawOnboardConfig): void {
  ensureConfigDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

export function clearOnboardConfig(): void {
  const path = configPath();
  if (existsSync(path)) {
    unlinkSync(path);
  }
}
