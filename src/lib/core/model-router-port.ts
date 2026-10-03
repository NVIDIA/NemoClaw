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

/** Recover a pre-routerPort cleanup identity without consulting the current blueprint. */
export function resolveLegacyModelRouterPort(
  session:
    | Record<string, unknown>
    | {
        provider?: unknown;
        routerPid?: unknown;
        routerCredentialHash?: unknown;
        endpointUrl?: unknown;
      },
): number | null {
  const hasRouterIdentity =
    session.provider === "nvidia-router" ||
    (typeof session.routerPid === "number" &&
      Number.isInteger(session.routerPid) &&
      session.routerPid > 0) ||
    (typeof session.routerCredentialHash === "string" && session.routerCredentialHash.length > 0);
  if (!hasRouterIdentity || typeof session.endpointUrl !== "string") return null;
  try {
    const endpoint = new URL(session.endpointUrl);
    const port = endpoint.port ? Number(endpoint.port) : null;
    return endpoint.protocol === "http:" &&
      endpoint.hostname === "host.openshell.internal" &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash &&
      port !== null &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535
      ? port
      : null;
  } catch {
    return null;
  }
}
