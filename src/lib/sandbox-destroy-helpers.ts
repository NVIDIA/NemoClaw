// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- pure helper tests exercise this module; orchestration coverage still runs through dist. */

import { stripAnsi } from "./openshell";

export type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

export function isMissingSandboxDeleteOutput(output = ""): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

export function getSandboxDeleteOutcome(deleteResult: SpawnLikeResult): {
  output: string;
  alreadyGone: boolean;
} {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  return {
    output,
    alreadyGone: deleteResult.status !== 0 && isMissingSandboxDeleteOutput(output),
  };
}

export function shouldStopHostServicesAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  registeredSandboxCount: number;
  sandboxStillRegistered: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.registeredSandboxCount === 1 &&
    input.sandboxStillRegistered
  );
}

export function shouldCleanupGatewayAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  removedRegistryEntry: boolean;
  noRegisteredSandboxes: boolean;
  noLiveSandboxes: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.removedRegistryEntry &&
    input.noRegisteredSandboxes &&
    input.noLiveSandboxes
  );
}

/* v8 ignore stop */
