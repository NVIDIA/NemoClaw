// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { validatePrepareE2eWorkflowBoundary } from "./prepare-e2e-workflow-boundary.mts";

type WorkflowRecord = Record<string, unknown>;

export function validateE2eWorkspaceBootstrapBoundary(workflow: WorkflowRecord): string[] {
  return validatePrepareE2eWorkflowBoundary(workflow);
}
