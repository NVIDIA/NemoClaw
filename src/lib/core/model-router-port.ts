// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { REPOSITORY_ROOT } from "./repository-root";

/** Default host port for the credential-bearing Model Router. */
export const DEFAULT_MODEL_ROUTER_PORT = 4000;

export type BlueprintRouterConfig = {
  enabled?: boolean;
  port?: number;
  pool_config_path?: string;
  credential_env?: string;
};

export type BlueprintInferenceProfile = {
  provider_name?: string;
  endpoint?: string;
  model: string;
  credential_env?: string;
  credential_default?: string;
  router: BlueprintRouterConfig;
};

/** Load an inference profile together with the shared router blueprint config. */
export function loadBlueprintProfile(
  profileName: string,
  rootDir: string = REPOSITORY_ROOT,
): BlueprintInferenceProfile | null {
  try {
    const YAML = require("yaml");
    const blueprintPath = path.join(rootDir, "nemoclaw-blueprint", "blueprint.yaml");
    if (!fs.existsSync(blueprintPath)) return null;
    const raw = fs.readFileSync(blueprintPath, "utf8");
    const parsed = YAML.parse(raw);
    const profile = parsed?.components?.inference?.profiles?.[profileName];
    if (!profile) return null;
    const router = { ...(parsed?.components?.router || {}) };
    if (typeof profile.credential_env === "string" && profile.credential_env.trim().length > 0) {
      router.credential_env = profile.credential_env;
    }
    return { ...profile, router } as BlueprintInferenceProfile;
  } catch {
    return null;
  }
}

/** Resolve the Model Router port used by the routed blueprint profile. */
export function resolveConfiguredModelRouterPort(rootDir: string = REPOSITORY_ROOT): number {
  return loadBlueprintProfile("routed", rootDir)?.router.port || DEFAULT_MODEL_ROUTER_PORT;
}
