// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { formatEnvAssignment } from "../core/url-utils";

const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";

type AgentLike = {
  readonly configPaths?: { readonly dir?: string };
} | null;

export function appendOpenClawRuntimeEnvArgs(envArgs: string[], agent: AgentLike): void {
  const configDir = agent?.configPaths?.dir || DEFAULT_OPENCLAW_CONFIG_DIR;
  const homeDir = path.posix.dirname(configDir);
  envArgs.push(formatEnvAssignment("OPENCLAW_HOME", homeDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_STATE_DIR", configDir));
  envArgs.push(formatEnvAssignment("OPENCLAW_WORKSPACE_DIR", `${configDir}/workspace`));
}
