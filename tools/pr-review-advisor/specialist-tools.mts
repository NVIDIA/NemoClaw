// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AdvisorInterest } from "./specialist-catalog.mts";
import { createTerminologyToolController, TERMINOLOGY_TRACE_TOOL } from "./terminology.mts";

const REPOSITORY_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export function specialistToolNames(interest: AdvisorInterest): string[] {
  return interest === "documentation-standard-work"
    ? [...REPOSITORY_READ_TOOL_NAMES, TERMINOLOGY_TRACE_TOOL]
    : [...REPOSITORY_READ_TOOL_NAMES];
}

export function specialistCustomTools(
  interest: AdvisorInterest,
  { baseRef, headRef, cwd = process.cwd() }: { baseRef: string; headRef: string; cwd?: string },
): ToolDefinition[] {
  return interest === "documentation-standard-work"
    ? createTerminologyToolController({ baseRef, headRef, cwd }).tools
    : [];
}
