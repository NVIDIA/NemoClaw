// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  POLICY_CONTEXT_SANDBOX_PATH,
  writePolicyContextToSandbox,
  type WritePolicyContextResult,
} from "./policy-explain";

/**
 * Result categories the refresh helper distinguishes when reporting outcomes:
 *
 * - `ok`: the sandbox confirmed the write.
 * - `unreachable`: the sandbox is not reachable (expected during onboard
 *   transitions and on hosts without OpenShell installed).
 * - `failed`: the sandbox is reachable but the write returned a non-zero
 *   status, which the caller should surface so the operator can react.
 * - `crashed`: the build/render or executor threw before reaching the
 *   sandbox; treated as an unexpected regression and re-emitted via the
 *   `unexpected` callback so it does not vanish into a generic catch.
 */
export type PolicyContextRefreshOutcome = "ok" | "unreachable" | "failed" | "crashed";

export interface RefreshOutcome extends WritePolicyContextResult {
  outcome: PolicyContextRefreshOutcome;
  errorMessage?: string;
}

export interface RefreshDeps {
  write?: typeof writePolicyContextToSandbox;
  warn?: (line: string) => void;
  /**
   * Sink for unexpected exceptions raised by the writer. Tests can inject
   * a spy to assert that import/build/render regressions do not get
   * swallowed silently.
   */
  unexpected?: (error: unknown) => void;
}

const DEFAULT_WARN = (line: string) => console.error(line);

const DEFAULT_UNEXPECTED = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`  Unexpected error refreshing ${POLICY_CONTEXT_SANDBOX_PATH}: ${message}`);
};

export function refreshSandboxPolicyContextFile(
  sandboxName: string,
  deps: RefreshDeps = {},
): RefreshOutcome {
  const write = deps.write ?? writePolicyContextToSandbox;
  const warn = deps.warn ?? DEFAULT_WARN;
  const unexpected = deps.unexpected ?? DEFAULT_UNEXPECTED;
  let result: WritePolicyContextResult;
  try {
    result = write(sandboxName);
  } catch (error: unknown) {
    unexpected(error);
    return {
      written: false,
      outcome: "crashed",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  if (result.written) {
    return { ...result, outcome: "ok" };
  }
  if (result.failure === "unexpected-loader") {
    unexpected(
      new Error(result.errorMessage ?? result.reason ?? "policy-context executor failed to load"),
    );
    return { ...result, outcome: "crashed" };
  }
  if (
    result.failure === "loader-vitest" ||
    result.failure === "no-runtime" ||
    result.failure === "sandbox-unreachable" ||
    result.reason === "sandbox unreachable"
  ) {
    return { ...result, outcome: "unreachable" };
  }
  warn(
    `  Could not refresh ${POLICY_CONTEXT_SANDBOX_PATH} for sandbox '${sandboxName}': ${result.reason ?? "unknown reason"}.`,
  );
  return { ...result, outcome: "failed" };
}

export { POLICY_CONTEXT_SANDBOX_PATH };
