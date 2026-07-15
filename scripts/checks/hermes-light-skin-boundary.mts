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

function main(): void {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, HERMES_DOCKERFILE_BASE), "utf8");
  const pinnedVersion = dockerfile.match(/^ARG HERMES_VERSION=(\S+)$/m)?.[1];
  if (!pinnedVersion) {
    throw new Error(`${HERMES_DOCKERFILE_BASE}: could not find ARG HERMES_VERSION`);
  }
  const reviewedVersions: readonly string[] = NEMOCLAW_HERMES_LIGHT_SKIN_REVIEWED_HERMES_VERSIONS;
  if (!reviewedVersions.includes(pinnedVersion)) {
    throw new Error(
      [
        "Hermes light terminal compatibility skin needs re-review.",
        `${HERMES_DOCKERFILE_BASE} pins ${pinnedVersion}, but connect-env.ts was reviewed for ${reviewedVersions.join(", ")}.`,
        "Remove the NemoClaw-managed light skin if upstream Hermes is readable in light terminals, or update the reviewed version constant after validating it still needs the shim.",
      ].join(" "),
    );
  }
}

main();
