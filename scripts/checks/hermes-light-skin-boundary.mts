// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS } = await import(
  "../../src/lib/domain/sandbox/connect-env"
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HERMES_DOCKERFILE_BASE = "agents/hermes/Dockerfile.base";

export function checkHermesLightSkinBoundary(options: {
  dockerfileText: string;
  reviewedVersions: readonly string[];
}): string | null {
  const { dockerfileText, reviewedVersions } = options;
  const pinnedVersion = dockerfileText.match(/^ARG HERMES_VERSION=(\S+)$/m)?.[1];
  if (!pinnedVersion) {
    return `${HERMES_DOCKERFILE_BASE}: could not find ARG HERMES_VERSION`;
  }
  if (!reviewedVersions.includes(pinnedVersion)) {
    return [
      "Hermes light terminal compatibility skin needs re-review.",
      `${HERMES_DOCKERFILE_BASE} pins ${pinnedVersion}, but connect-env.ts was reviewed for ${reviewedVersions.join(", ")}.`,
      "Remove the NemoClaw-managed light skin if upstream Hermes is readable in light terminals, or update the reviewed version constant after validating it still needs the shim.",
    ].join(" ");
  }
  return null;
}

function main(): void {
  const dockerfileText = fs.readFileSync(path.join(REPO_ROOT, HERMES_DOCKERFILE_BASE), "utf8");
  const error = checkHermesLightSkinBoundary({
    dockerfileText,
    reviewedVersions: NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS,
  });
  if (error) throw new Error(error);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main();
}
