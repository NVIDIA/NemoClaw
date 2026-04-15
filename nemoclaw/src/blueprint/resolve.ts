// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const BLUEPRINT_CACHE_DIR = join(process.env.HOME ?? "/tmp", ".nemoclaw", "blueprints");
const SAFE_BLUEPRINT_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

export interface CachedBlueprintManifest {
  version: string | null;
  min_openshell_version: string | null;
  min_openclaw_version: string | null;
  digest: string | null;
  profiles: string[];
}

export function getCacheDir(): string {
  return BLUEPRINT_CACHE_DIR;
}

export function getCachedBlueprintPath(version: string): string {
  return join(BLUEPRINT_CACHE_DIR, validateBlueprintVersion(version));
}

export function isCached(version: string): boolean {
  return existsSync(join(getCachedBlueprintPath(version), "blueprint.yaml"));
}

export function readCachedManifest(version: string): CachedBlueprintManifest | null {
  try {
    const blueprintPath = join(getCachedBlueprintPath(version), "blueprint.yaml");
    const parsed = parse(readFileSync(blueprintPath, "utf-8")) as Record<string, unknown> | null;

    return {
      version: readString(parsed?.version),
      min_openshell_version: readString(parsed?.min_openshell_version),
      min_openclaw_version: readString(parsed?.min_openclaw_version),
      digest: readString(parsed?.digest),
      profiles: readProfiles(parsed?.profiles),
    };
  } catch {
    return null;
  }
}

function validateBlueprintVersion(version: string): string {
  if (!SAFE_BLUEPRINT_VERSION.test(version) || version.includes("..")) {
    throw new TypeError(`Invalid blueprint version: ${version}`);
  }
  return version;
}

function readString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError("Manifest field must be a string");
}

function readProfiles(profiles: unknown): string[] {
  if (
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    !profiles.every((profile) => typeof profile === "string") ||
    new Set(profiles).size !== profiles.length
  ) {
    return ["default"];
  }

  return profiles;
}
