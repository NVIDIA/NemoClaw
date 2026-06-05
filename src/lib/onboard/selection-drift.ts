// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProviderSelectionConfig } from "../inference/config";

export type SelectionDrift = {
  changed: boolean;
  providerChanged: boolean;
  modelChanged: boolean;
  existingProvider: string | null;
  existingModel: string | null;
  unknown: boolean;
};

type RunOpenshellForSelection = (
  args: string[],
  opts: { ignoreError: true; stdio: ["ignore", "ignore", "ignore"] },
) => { status: number | null };

export type SelectionConfigReadDeps = {
  runOpenshell: RunOpenshellForSelection;
  tmpDir?: string;
};

export function findSelectionConfigPath(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSelectionConfigPath(fullPath);
      if (found) return found;
      continue;
    }
    if (entry.name === "config.json") {
      return fullPath;
    }
  }
  return null;
}

export function readSandboxSelectionConfig(
  sandboxName: string,
  deps: SelectionConfigReadDeps,
): ProviderSelectionConfig | null {
  if (!sandboxName) return null;
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), "nemoclaw-selection-"));
    const result = deps.runOpenshell(
      [
        "sandbox",
        "download",
        sandboxName,
        "/sandbox/.nemoclaw/config.json",
        `${tmpDir}${path.sep}`,
      ],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const configPath = findSelectionConfigPath(tmpDir);
    if (!configPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

export function getSelectionDrift(
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  deps: SelectionConfigReadDeps,
): SelectionDrift {
  const existing = readSandboxSelectionConfig(sandboxName, deps);
  if (!existing) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      unknown: true,
    };
  }

  const existingProvider = typeof existing.provider === "string" ? existing.provider : null;
  const existingModel = typeof existing.model === "string" ? existing.model : null;
  if (!existingProvider || !existingModel) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider,
      existingModel,
      unknown: true,
    };
  }

  const providerChanged = Boolean(
    existingProvider && requestedProvider && existingProvider !== requestedProvider,
  );
  const modelChanged = Boolean(existingModel && requestedModel && existingModel !== requestedModel);

  return {
    changed: providerChanged || modelChanged,
    providerChanged,
    modelChanged,
    existingProvider,
    existingModel,
    unknown: false,
  };
}
