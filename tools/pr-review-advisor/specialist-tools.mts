// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AdvisorInterest } from "./specialist-catalog.mts";
import { createTerminologyToolController, TERMINOLOGY_TRACE_TOOL } from "./terminology.mts";

type ToolContext = { baseRef: string; headRef: string; cwd?: string };
type SpecialistToolPolicy = {
  name: string;
  create: (context: ToolContext) => ToolDefinition;
};

const REPOSITORY_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;
const SPECIALIST_TOOL_POLICY: Partial<Record<AdvisorInterest, SpecialistToolPolicy[]>> = {
  "documentation-standard-work": [
    {
      name: TERMINOLOGY_TRACE_TOOL,
      create: (context) => createTerminologyToolController(context).tools[0]!,
    },
  ],
};

function customToolPolicy(interest: AdvisorInterest): SpecialistToolPolicy[] {
  return SPECIALIST_TOOL_POLICY[interest] ?? [];
}

export function specialistToolNames(interest: AdvisorInterest): string[] {
  return [...REPOSITORY_READ_TOOL_NAMES, ...customToolPolicy(interest).map(({ name }) => name)];
}

export function specialistCustomTools(
  interest: AdvisorInterest,
  context: ToolContext,
): ToolDefinition[] {
  return customToolPolicy(interest).map(({ create }) => create(context));
}
