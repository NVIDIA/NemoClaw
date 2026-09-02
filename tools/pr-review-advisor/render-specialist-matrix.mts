// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { ADVISOR_SPECIALISTS } from "./specialist-catalog.mts";

const configuredModel = process.env.PR_REVIEW_ADVISOR_MODEL?.trim();
const models = configuredModel
  ? [configuredModel]
  : ["openai/gpt-5.6-terra", "azure/openai/gpt-5.6-terra"];
const matrix = ADVISOR_SPECIALISTS.map(({ interest, label }, index) => ({
  interest,
  label,
  model: models[index % models.length],
  artifact_dir: `pr-review-specialist-${interest}`,
  artifact_name: `pr-review-specialist-${interest}`,
}));
const output = JSON.stringify(matrix);
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
  fs.appendFileSync(githubOutput, `matrix=${output}\n`);
} else {
  process.stdout.write(`${output}\n`);
}
