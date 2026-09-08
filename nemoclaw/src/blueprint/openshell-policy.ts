// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedOpenShellPolicyBoundary from "../shared/openshell-policy-boundary.cjs";
import type {
  OpenShellPolicyInspection,
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicySetCommandResult,
  OpenShellSandboxPolicySetSubmission,
} from "../shared/openshell-policy-boundary.cjs";

const sourceOrGeneratedOpenShellPolicyBoundary =
  importedOpenShellPolicyBoundary as typeof importedOpenShellPolicyBoundary & {
    default?: typeof importedOpenShellPolicyBoundary;
  };
const {
  buildOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs,
  buildOpenShellSandboxPolicySetArgs,
  classifyOpenShellSandboxPolicySetResult,
  parseOpenShellSandboxPolicyRead,
  parseSandboxPolicyMetadata,
} = sourceOrGeneratedOpenShellPolicyBoundary.default ?? sourceOrGeneratedOpenShellPolicyBoundary;

type PolicyTarget = Readonly<{ gatewayName: string; sandboxName: string }>;

export type BlueprintOpenShellPolicyReadCapture = (
  command: string[],
  gatewayName: string,
) => Promise<Readonly<{ stdout: string }>>;

export type BlueprintOpenShellPolicyWriteCapture = (
  command: string[],
  gatewayName: string,
) => Promise<OpenShellSandboxPolicySetCommandResult>;

export type BlueprintOpenShellPolicyClient = Readonly<{
  inspectSandboxPolicy: (target: PolicyTarget) => Promise<OpenShellPolicyInspection>;
  readSandboxBasePolicy: (target: PolicyTarget) => Promise<OpenShellSandboxPolicyRead>;
  readSandboxPolicyRevision: (
    target: PolicyTarget & Readonly<{ revision: number }>,
  ) => Promise<OpenShellSandboxPolicyRead>;
  setSandboxPolicy: (
    target: PolicyTarget & Readonly<{ policyPath: string }>,
  ) => Promise<OpenShellSandboxPolicySetSubmission>;
}>;

/** Bind Blueprint orchestration to the shared typed OpenShell policy contract. */
export function createBlueprintOpenShellPolicyClient(deps: {
  captureRead: BlueprintOpenShellPolicyReadCapture;
  captureWrite: BlueprintOpenShellPolicyWriteCapture;
}): BlueprintOpenShellPolicyClient {
  return {
    inspectSandboxPolicy: async (target) => {
      const captured = await deps.captureRead(
        ["openshell", ...buildOpenShellSandboxPolicyInspectionArgs(target)],
        target.gatewayName,
      );
      return parseSandboxPolicyMetadata(captured.stdout, target.sandboxName);
    },
    readSandboxBasePolicy: async (target) => {
      const captured = await deps.captureRead(
        [
          "openshell",
          ...buildOpenShellSandboxPolicyReadArgs({
            ...target,
            scope: "base",
          }),
        ],
        target.gatewayName,
      );
      return parseOpenShellSandboxPolicyRead(captured.stdout);
    },
    readSandboxPolicyRevision: async (target) => {
      const captured = await deps.captureRead(
        ["openshell", ...buildOpenShellSandboxPolicyRevisionReadArgs(target)],
        target.gatewayName,
      );
      return parseOpenShellSandboxPolicyRead(captured.stdout);
    },
    setSandboxPolicy: async (target) => {
      const captured = await deps.captureWrite(
        ["openshell", ...buildOpenShellSandboxPolicySetArgs(target)],
        target.gatewayName,
      );
      return {
        outcome: classifyOpenShellSandboxPolicySetResult(captured),
        status: captured.status,
      };
    },
  };
}
