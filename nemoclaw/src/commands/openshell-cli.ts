// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { PluginLogger } from "../index.js";

export function ensureOpenShellCli(logger: PluginLogger, commandName: string): boolean {
  const probe = spawnSync("openshell", ["--version"], {
    stdio: "ignore",
  });

  if (!probe.error && probe.status === 0) {
    return true;
  }

  logger.error(
    `OpenShell CLI (\`openshell\`) is required for \`${commandName}\` but was not found on PATH.`,
  );
  logger.info("Install OpenShell and ensure the `openshell` command is available before retrying.");
  logger.info("See the NemoClaw prerequisites/installation docs for the supported setup path.");
  return false;
}
