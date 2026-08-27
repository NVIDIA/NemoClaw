// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxMessagingEnvLinesRenderPlan,
  SandboxMessagingPlan,
} from "../../messaging/manifest/types";

export interface PreservedEnvInventory {
  readonly path: string;
  readonly patterns: readonly string[];
}

export interface PreservedEnvFile {
  readonly path: string;
  readonly assignments: readonly string[];
}

export const HERMES_PRESERVED_ENV_INVENTORY: readonly PreservedEnvInventory[] = [
  {
    path: ".env",
    patterns: ["*_HOME_CHANNEL", "*_HOME_CHANNEL_NAME", "*_HOME_CHANNEL_THREAD_ID"],
  },
];
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const ENV_PATTERN_RE = /^[A-Z0-9_*]+$/;
const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_ENV_ASSIGNMENT_BYTES = 8192;

function envPatternRegex(pattern: string): RegExp {
  if (
    !ENV_PATTERN_RE.test(pattern) ||
    !pattern.includes("*") ||
    pattern.replaceAll("*", "").length === 0
  ) {
    throw new Error(`Invalid preserved environment pattern '${pattern}'`);
  }
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

export function isPreservedEnvKey(key: string, patterns: readonly string[]): boolean {
  return ENV_KEY_RE.test(key) && patterns.some((pattern) => envPatternRegex(pattern).test(key));
}

export function extractPreservedEnvAssignments(
  contents: string,
  inventory: PreservedEnvInventory,
): string[] {
  if (Buffer.byteLength(contents, "utf8") > MAX_ENV_FILE_BYTES) {
    throw new Error(`Preserved environment source '${inventory.path}' is too large`);
  }

  const assignments: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    if (!isPreservedEnvKey(key, inventory.patterns)) continue;
    if (seen.has(key)) {
      throw new Error(`Preserved environment source '${inventory.path}' repeats key '${key}'`);
    }
    if (/[\u0000-\u001f\u007f]/.test(line)) {
      throw new Error(`Preserved environment key '${key}' contains control characters`);
    }
    const assignment = `${key}=${match[2] ?? ""}`;
    if (Buffer.byteLength(assignment, "utf8") > MAX_ENV_ASSIGNMENT_BYTES) {
      throw new Error(`Preserved environment key '${key}' is too large`);
    }
    seen.add(key);
    assignments.push(assignment);
  }
  return assignments;
}

export function validatePreservedEnvFiles(
  files: unknown,
  inventories: readonly PreservedEnvInventory[],
): files is PreservedEnvFile[] {
  if (!Array.isArray(files)) return false;
  const inventoryByPath = new Map(inventories.map((inventory) => [inventory.path, inventory]));
  const seenPaths = new Set<string>();
  return files.every((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return false;
    }
    const record = candidate as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => key !== "path" && key !== "assignments") ||
      typeof record.path !== "string" ||
      !Array.isArray(record.assignments) ||
      seenPaths.has(record.path)
    ) {
      return false;
    }
    const inventory = inventoryByPath.get(record.path);
    if (!inventory) return false;
    const seenKeys = new Set<string>();
    for (const assignment of record.assignments) {
      if (
        typeof assignment !== "string" ||
        /[\r\n\u0000]/.test(assignment) ||
        Buffer.byteLength(assignment, "utf8") > MAX_ENV_ASSIGNMENT_BYTES
      ) {
        return false;
      }
      const separator = assignment.indexOf("=");
      if (separator <= 0) return false;
      const key = assignment.slice(0, separator);
      if (!isPreservedEnvKey(key, inventory.patterns) || seenKeys.has(key)) {
        return false;
      }
      seenKeys.add(key);
    }
    seenPaths.add(record.path);
    return true;
  });
}

export function mergeHermesPreservedEnvIntoMessagingPlan(
  plan: SandboxMessagingPlan,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): SandboxMessagingPlan;
export function mergeHermesPreservedEnvIntoMessagingPlan(
  plan: null,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): null;
export function mergeHermesPreservedEnvIntoMessagingPlan(
  plan: SandboxMessagingPlan | null,
  preservedFiles: readonly PreservedEnvFile[] | undefined,
): SandboxMessagingPlan | null {
  if (!plan || plan.agent !== "hermes" || !preservedFiles || preservedFiles.length === 0) {
    return plan;
  }
  if (!validatePreservedEnvFiles(preservedFiles, HERMES_PRESERVED_ENV_INVENTORY)) {
    throw new Error("Invalid preserved environment assignments");
  }
  const assignments = preservedFiles
    .filter((file) => file.path === ".env")
    .flatMap((file) => file.assignments);
  if (assignments.length === 0) return plan;

  const enabledChannels = plan.channels.filter(
    (channel) => channel.active && !channel.disabled,
  );
  // Prefer a channel that already renders into ~/.hermes/.env so the preserved
  // lines ride along with an existing entry. Fall back to any enabled channel:
  // whether a channel renders env lines depends on its inputs, and anchoring
  // only on that would silently drop the captured home-channel values whenever
  // no channel happens to render one.
  const activeChannel =
    enabledChannels.find((channel) =>
      plan.agentRender.some(
        (render) =>
          render.channelId === channel.channelId &&
          render.kind === "env-lines" &&
          render.agent === "hermes" &&
          render.target === "~/.hermes/.env",
      ),
    ) ?? enabledChannels[0];
  if (!activeChannel) return plan;

  const preservedRender: SandboxMessagingEnvLinesRenderPlan = {
    channelId: activeChannel.channelId,
    renderId: "hermes-preserved-home-channels",
    hookId: "hermes-preserved-home-channels",
    handler: "common.staticOutputs",
    kind: "env-lines",
    agent: "hermes",
    target: "~/.hermes/.env",
    lines: assignments,
    templateRefs: [],
  };
  return {
    ...plan,
    // Preserved values are applied first. A current manifest render for the
    // same key remains authoritative because the env merger processes it later.
    agentRender: [preservedRender, ...plan.agentRender],
  };
}
