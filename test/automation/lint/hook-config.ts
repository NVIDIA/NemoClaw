// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export function writeLocalHookConfig(root: string): void {
  const config = YAML.parse(fs.readFileSync(".pre-commit-config.yaml", "utf8")) as {
    repos: Array<{ repo: string }>;
  };
  // Prek initializes remote repositories even when only a local hook is selected.
  config.repos = config.repos.filter(({ repo }) => repo === "local");
  fs.writeFileSync(path.join(root, ".pre-commit-config.yaml"), YAML.stringify(config));
}
