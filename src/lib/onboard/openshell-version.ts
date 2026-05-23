// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import { ROOT, runCapture } from "../runner";

export function getInstalledOpenshellVersion(versionOutput: string | null = null): string | null {
  const openshellBin = resolveOpenshell();
  if (!versionOutput && !openshellBin) return null;
  const output = String(
    versionOutput ?? runCapture([openshellBin as string, "-V"], { ignoreError: true }),
  ).trim();
  const match = output.match(/openshell\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (match) return match[1];
  return null;
}

/**
 * Compare two semver-like x.y.z strings. Returns true iff `left >= right`.
 * Non-numeric or missing components are treated as 0.
 */
export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

/**
 * Read a semver field from nemoclaw-blueprint/blueprint.yaml. Returns null if
 * the blueprint or field is missing or unparseable — callers must treat null
 * as "no constraint configured" so a malformed install does not become a hard
 * onboard blocker. See #1317.
 */
function getBlueprintVersionField(field: string, rootDir = ROOT): string | null {
  try {
    // Lazy require: yaml is already a dependency via the policy helpers but
    // pulling it at module load would slow down `nemoclaw --help` for users
    // who never reach the preflight path.
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const value = parsed && parsed[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function getBlueprintMinOpenshellVersion(rootDir = ROOT): string | null {
  return getBlueprintVersionField("min_openshell_version", rootDir);
}

export function getBlueprintMaxOpenshellVersion(rootDir = ROOT): string | null {
  return getBlueprintVersionField("max_openshell_version", rootDir);
}

export type OpenshellChannel = "stable" | "dev" | "auto";

export function getOpenshellChannel(env: NodeJS.ProcessEnv = process.env): OpenshellChannel {
  const raw = String(env.NEMOCLAW_OPENSHELL_CHANNEL || "auto")
    .trim()
    .toLowerCase();
  if (raw === "stable" || raw === "dev" || raw === "auto") return raw;
  return "auto";
}

export function shouldUseOpenshellDevChannel(
  _platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const channel = getOpenshellChannel(env);
  return channel === "dev";
}

export function isOpenshellDevVersion(versionOutput: string | null | undefined): boolean {
  return /\bdev[0-9.]*/i.test(String(versionOutput || ""));
}

export function shouldAllowOpenshellAboveBlueprintMax(
  versionOutput: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return shouldUseOpenshellDevChannel(platform, env) && isOpenshellDevVersion(versionOutput);
}
