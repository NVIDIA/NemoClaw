// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SandboxLifecycleHelpers } from "./sandbox-lifecycle";

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

export type GetOpenclawSelectionDrift = (
  sandboxName: string,
  provider: string,
  model: string,
) => SelectionDrift;

type RunOpenshellForSelection = (
  args: string[],
  opts: { ignoreError: true; stdio: ["ignore", "ignore", "ignore"] },
) => { status: number | null };

export type SelectionConfigReadDeps = {
  runOpenshell: RunOpenshellForSelection;
  tmpDir?: string;
};

export type GetSelectionDriftWithDeps = (
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  deps: SelectionConfigReadDeps,
) => SelectionDrift;

export interface OpenclawSelectionDriftDepsRuntime {
  runOpenshell: SelectionConfigReadDeps["runOpenshell"];
  isNonInteractive(): boolean;
  confirmRecreateForSelectionDrift(
    sandboxName: string,
    drift: SelectionDrift,
    requestedProvider: string | null,
    requestedModel: string | null,
  ): Promise<boolean>;
}

export interface OpenclawSelectionGuardDepsRuntime extends OpenclawSelectionDriftDepsRuntime {
  getSelectionDrift: GetSelectionDriftWithDeps;
  inspectSandboxForCreate: SandboxLifecycleHelpers["inspectSandboxForCreate"];
  isOpenclawReady: SandboxLifecycleHelpers["isOpenclawReady"];
  isRecreateSandbox(requested?: boolean): boolean;
}

export function createOpenclawSelectionDriftDeps(runtime: OpenclawSelectionDriftDepsRuntime) {
  return {
    getSelectionDrift: (sandboxName: string, provider: string, model: string) =>
      getSelectionDrift(sandboxName, provider, model, { runOpenshell: runtime.runOpenshell }),
    isNonInteractive: runtime.isNonInteractive,
    confirmRecreateForSelectionDrift: runtime.confirmRecreateForSelectionDrift,
  };
}

export function createOpenclawReaderDeps(
  getSelectionDrift: GetSelectionDriftWithDeps,
  isOpenclawReady: SandboxLifecycleHelpers["isOpenclawReady"],
) {
  return { getSelectionDrift, isOpenclawReady };
}

export function createOpenclawSelectionGuardDeps(runtime: OpenclawSelectionGuardDepsRuntime) {
  return {
    inspectSandboxForCreate: runtime.inspectSandboxForCreate,
    isOpenclawReady: runtime.isOpenclawReady,
    getOpenclawSelectionDrift: (sandboxName: string, provider: string, model: string) =>
      runtime.getSelectionDrift(sandboxName, provider, model, {
        runOpenshell: runtime.runOpenshell,
      }),
    recreateSandbox: runtime.isRecreateSandbox,
  };
}

export function findSelectionConfigPath(dir: string): string | null {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findSelectionConfigPath(fullPath);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && entry.name === "config.json") {
      return fullPath;
    }
  }
  return null;
}

function isContainedBy(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function readSandboxSelectionConfig(
  sandboxName: string,
  deps: SelectionConfigReadDeps,
): SelectionIdentity | null {
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
    const configStat = fs.lstatSync(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink()) return null;
    const tmpDirRealPath = fs.realpathSync(tmpDir);
    const configRealPath = fs.realpathSync(configPath);
    if (!isContainedBy(tmpDirRealPath, configRealPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configRealPath, "utf-8")) as Record<string, unknown>;
    const provider = normalizeSelectionComponent(parsed.provider);
    const model = normalizeSelectionComponent(parsed.model);
    return provider && model ? { provider, model } : null;
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
