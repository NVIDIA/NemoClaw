// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Legacy result reasons retained while callers remove stored recovery records. */
export type SecretBoundaryRefusalReason =
  | "raw-secret"
  | "exec-failed"
  | "validator-missing"
  | "unexpected-marker"
  | "agent-missing";

export const HERMES_RESTART_SECRET_BOUNDARY_COMMAND =
  "/usr/bin/timeout 30 /usr/bin/python3 -I /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py env-file /sandbox/.hermes/.env";

export type HermesBoundaryCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export async function validateHermesRestartSecretBoundary(
  sandboxName: string,
  execute: (
    sandboxName: string,
    command: string,
    timeout?: number,
  ) => Promise<HermesBoundaryCommandResult | null>,
): Promise<HermesBoundaryCommandResult | null> {
  return execute(sandboxName, HERMES_RESTART_SECRET_BOUNDARY_COMMAND, 45_000);
}
