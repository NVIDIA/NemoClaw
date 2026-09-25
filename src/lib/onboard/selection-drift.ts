// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SELECTION_COMPONENT_BYTES = 512;
const SAFE_SELECTION_COMPONENT = /^[A-Za-z0-9._:/-]+$/u;

type SelectionIdentity = {
  provider: string;
  model: string;
};

export function normalizeSelectionComponent(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_SELECTION_COMPONENT_BYTES &&
    SAFE_SELECTION_COMPONENT.test(value)
    ? value
    : null;
}

export type SelectionDrift = {
  changed: boolean;
  providerChanged: boolean;
  modelChanged: boolean;
  existingProvider: string | null;
  existingModel: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
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

export function findSelectionConfigPath(dir: string, filename = "config.json"): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSelectionConfigPath(fullPath, filename);
      if (found) return found;
      continue;
    }
    if (entry.name === filename) {
      return fullPath;
    }
  }
  return null;
}

function readDownloadedSelectionSource(
  sandboxName: string,
  remotePath: string,
  filename: string,
  deps: SelectionConfigReadDeps,
): string | null {
  if (!sandboxName) return null;
  let tmpDir: string | undefined;
  try {
    tmpDir = fs.mkdtempSync(path.join(deps.tmpDir ?? os.tmpdir(), "nemoclaw-selection-"));
    const result = deps.runOpenshell(
      ["sandbox", "download", sandboxName, remotePath, `${tmpDir}${path.sep}`],
      { ignoreError: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    if (result.status !== 0) return null;
    const configPath = findSelectionConfigPath(tmpDir, filename);
    if (!configPath) return null;
    return fs.readFileSync(configPath, "utf-8");
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

export function readSandboxSelectionConfig(
  sandboxName: string,
  deps: SelectionConfigReadDeps,
): SelectionIdentity | null {
  const raw = readDownloadedSelectionSource(
    sandboxName,
    "/sandbox/.nemoclaw/config.json",
    "config.json",
    deps,
  );
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const provider = normalizeSelectionComponent(parsed.provider);
    const model = normalizeSelectionComponent(parsed.model);
    return provider && model ? { provider, model } : null;
  } catch {
    return null;
  }
}

export function getSelectionDrift(
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  deps: SelectionConfigReadDeps,
): SelectionDrift {
  // Compare onboarding intent, not native OpenClaw edits made after creation.
  // An unreadable record stays unknown; native config is not a deletion signal.
  const existing = readSandboxSelectionConfig(sandboxName, deps);
  if (!existing) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      requestedProvider,
      requestedModel,
      unknown: true,
    };
  }

  const existingProvider = existing.provider;
  const existingModel = existing.model;
  const providerChanged = Boolean(requestedProvider && existingProvider !== requestedProvider);
  const modelChanged = Boolean(requestedModel && existingModel !== requestedModel);

  return {
    changed: providerChanged || modelChanged,
    providerChanged,
    modelChanged,
    existingProvider,
    existingModel,
    requestedProvider,
    requestedModel,
    unknown: false,
  };
}
