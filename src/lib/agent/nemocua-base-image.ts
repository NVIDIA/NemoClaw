// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { AgentDefinition } from "./defs";

export const NEMOCUA_RUNTIME_IMAGE_ENV = "NEMOCLAW_NEMOCUA_RUNTIME_IMAGE_REF";

export function getNemoCuaBaseImageBuildArgs(
  agent: Pick<AgentDefinition, "name" | "agentDir">,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (agent.name !== "nemocua") return undefined;
  const raw = JSON.parse(
    fs.readFileSync(path.join(agent.agentDir, "runtime-artifacts.json"), "utf8"),
  ) as { sandboxImage?: { digest?: unknown } };
  const digest = raw.sandboxImage?.digest;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error("NemoCUA runtime artifacts do not declare a valid sandbox image digest");
  }
  const sourceRef = env[NEMOCUA_RUNTIME_IMAGE_ENV]?.trim() ?? "";
  if (!sourceRef) {
    throw new Error(
      `${NEMOCUA_RUNTIME_IMAGE_ENV} must identify the verified NemoCUA OCI image before building the local base`,
    );
  }
  if (!sourceRef.endsWith(`@${digest}`) || /[\s\x00-\x1f]/.test(sourceRef)) {
    throw new Error(
      `${NEMOCUA_RUNTIME_IMAGE_ENV} must be an immutable reference ending in @${digest}`,
    );
  }
  return { NEMOCUA_RUNTIME_IMAGE: sourceRef };
}
