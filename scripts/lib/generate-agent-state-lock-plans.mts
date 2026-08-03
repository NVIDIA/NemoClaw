// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const { buildStateLockPlan, readStateDirectories } = await import(
  "../../src/lib/agent/state-directory-contract"
);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE_AGENTS = ["openclaw", "hermes"] as const;
const SPDX_COMMENT =
  "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\nSPDX-License-Identifier: Apache-2.0";

for (const agentName of IMAGE_AGENTS) {
  const manifestPath = path.join(REPO_ROOT, "agents", agentName, "manifest.yaml");
  const manifest = YAML.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Agent manifest must be an object: ${manifestPath}`);
  }
  const outputPath = path.join(REPO_ROOT, "agents", agentName, "state-lock-plan.json");
  const output = `${JSON.stringify(
    {
      $comment: SPDX_COMMENT,
      ...buildStateLockPlan(readStateDirectories(manifest as Record<string, unknown>)),
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(outputPath, output);
  process.stdout.write(`${path.relative(REPO_ROOT, outputPath)}\n`);
}
