// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { listAgents, loadAgent } = await import("../../src/lib/agent/defs");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SPDX_COMMENT =
  "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.\nSPDX-License-Identifier: Apache-2.0";

for (const agentName of listAgents()) {
  const agent = loadAgent(agentName);
  if (!agent.stateLockPlanInImage) continue;

  const outputPath = path.join(agent.agentDir, "state-lock-plan.json");
  const output = `${JSON.stringify(
    {
      $comment: SPDX_COMMENT,
      ...agent.stateLockPlan,
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(outputPath, output);
  process.stdout.write(`${path.relative(REPO_ROOT, outputPath)}\n`);
}
