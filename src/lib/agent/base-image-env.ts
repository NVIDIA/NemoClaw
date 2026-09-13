// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CUA_SANDBOX_IMAGE_ENV } from "../cua/feature";

export function getAgentSandboxBaseImageEnvVar(agentName: string): string {
  if (agentName === "openclaw") return "NEMOCLAW_SANDBOX_BASE_IMAGE_REF";
  if (agentName === "nemocua") return CUA_SANDBOX_IMAGE_ENV;
  return `NEMOCLAW_${agentName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_SANDBOX_BASE_IMAGE_REF`;
}
