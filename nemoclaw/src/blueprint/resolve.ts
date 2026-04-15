// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const BLUEPRINT_CACHE_DIR = join(process.env.HOME ?? "/tmp", ".nemoclaw", "blueprints");

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
  return join(BLUEPRINT_CACHE_DIR, version);
}

export function isCached(version: string): boolean {
  return existsSync(join(getCachedBlueprintPath(version), "blueprint.yaml"));
}

export function readCachedManifest(version: string): CachedBlueprintManifest | null {
  const blueprintPath = join(getCachedBlueprintPath(version), "blueprint.yaml");
  if (!existsSync(blueprintPath)) {
    return null;
  }

  const parsed = parse(readFileSync(blueprintPath, "utf-8")) as Record<string, unknown> | null;
  const profiles = parsed?.profiles;

  return {
    version: readString(parsed?.version),
    min_openshell_version: readString(parsed?.min_openshell_version),
    min_openclaw_version: readString(parsed?.min_openclaw_version),
    digest: readString(parsed?.digest),
    profiles:
      Array.isArray(profiles) && profiles.every((profile) => typeof profile === "string")
        ? profiles
        : ["default"],
  };
}

function readString(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
