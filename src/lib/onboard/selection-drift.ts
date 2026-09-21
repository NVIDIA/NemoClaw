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

export type OpenClawSelectionTarget = {
  providerKey: string;
  primaryModelRef: string;
};

function resolveOpenClawSelectionTarget(
  target: OpenClawSelectionTarget | null,
): SelectionIdentity | null {
  if (!target) return null;
  const separator = target.primaryModelRef.indexOf("/");
  if (separator <= 0 || separator === target.primaryModelRef.length - 1) return null;
  const provider = normalizeSelectionComponent(target.providerKey);
  const model = normalizeSelectionComponent(target.primaryModelRef.slice(separator + 1));
  return provider && model ? { provider, model } : null;
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
  runCaptureOpenshell?: (args: string[], opts: { ignoreError: true; timeout: number }) => string;
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

export function readOpenClawSelectionConfig(
  sandboxName: string,
  deps: SelectionConfigReadDeps,
): SelectionIdentity | null {
  if (!sandboxName || !deps.runCaptureOpenshell) return null;
  try {
    // Let OpenClaw parse its credential-bearing JSON5 inside the sandbox. Only
    // the requested scalar crosses into the host process.
    const output = deps.runCaptureOpenshell(
      [
        "sandbox",
        "exec",
        "--name",
        sandboxName,
        "--",
        "/usr/bin/env",
        "HOME=/sandbox",
        "/usr/local/bin/openclaw",
        "config",
        "get",
        "agents.defaults.model.primary",
        "--json",
      ],
      { ignoreError: true, timeout: 30_000 },
    );
    const primary = JSON.parse(output) as unknown;
    if (typeof primary !== "string") return null;
    const separator = primary.indexOf("/");
    if (separator <= 0 || separator === primary.length - 1) return null;
    const provider = normalizeSelectionComponent(primary.slice(0, separator));
    const model = normalizeSelectionComponent(primary.slice(separator + 1));
    return provider && model ? { provider, model } : null;
  } catch {
    return null;
  }
}

export function getSelectionDrift(
  sandboxName: string,
  requestedProvider: string | null,
  requestedModel: string | null,
  agentName: string | null,
  openClawTarget: OpenClawSelectionTarget | null,
  deps: SelectionConfigReadDeps,
): SelectionDrift {
  const openClawRequest = agentName === "openclaw";
  const requestedOpenClawSelection = openClawRequest
    ? resolveOpenClawSelectionTarget(openClawTarget)
    : null;
  if (openClawRequest && !requestedOpenClawSelection) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      requestedProvider: null,
      requestedModel: null,
      unknown: true,
    };
  }
  const existing = openClawRequest
    ? readOpenClawSelectionConfig(sandboxName, deps)
    : readSandboxSelectionConfig(sandboxName, deps);
  if (!existing) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      requestedProvider: requestedOpenClawSelection?.provider ?? requestedProvider,
      requestedModel: requestedOpenClawSelection?.model ?? requestedModel,
      unknown: true,
    };
  }

  const existingProvider = existing.provider;
  const existingModel = existing.model;
  if (!existingProvider || !existingModel) {
    return {
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider,
      existingModel,
      requestedProvider: requestedOpenClawSelection?.provider ?? requestedProvider,
      requestedModel: requestedOpenClawSelection?.model ?? requestedModel,
      unknown: true,
    };
  }

  const requestedNativeProvider = openClawRequest
    ? requestedOpenClawSelection?.provider
    : requestedProvider;
  const requestedNativeModel = openClawRequest ? requestedOpenClawSelection?.model : requestedModel;
  const providerChanged = Boolean(
    existingProvider && requestedNativeProvider && existingProvider !== requestedNativeProvider,
  );
  const modelChanged = Boolean(
    existingModel && requestedNativeModel && existingModel !== requestedNativeModel,
  );

  return {
    changed: providerChanged || modelChanged,
    providerChanged,
    modelChanged,
    existingProvider,
    existingModel,
    requestedProvider: requestedNativeProvider,
    requestedModel: requestedNativeModel,
    unknown: false,
  };
}
