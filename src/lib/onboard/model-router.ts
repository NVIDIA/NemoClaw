// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { REPOSITORY_ROOT } from "../core/repository-root";

/** Legacy router identities remain recognizable for explicit destroy and uninstall. */
export { DEFAULT_MODEL_ROUTER_PORT } from "../core/model-router-port";
export function isRoutedInferenceProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  if (provider === "nvidia-router") return true;
  // Read only the retained legacy alias for cleanup. This never enables a profile.
  try {
    const blueprint = YAML.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, "nemoclaw-blueprint", "blueprint.yaml"), "utf8"),
    );
    const alias = blueprint?.components?.inference?.profiles?.routed?.provider_name;
    return typeof alias === "string" && alias.length > 0 && provider === alias;
  } catch {
    return false;
  }
}
