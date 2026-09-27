// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PreApprovalAdminProbeOutcome =
  | "approval-required"
  | "command-failed"
  | "gateway-unavailable"
  | "timeout"
  | "unexpected-success";

export interface PreApprovalAdminProbeResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export function preApprovalAdminProbeEvidence(result: PreApprovalAdminProbeResult): {
  outcome: PreApprovalAdminProbeOutcome;
} {
  if (result.timedOut) return { outcome: "timeout" };
  if (result.exitCode === 0) return { outcome: "unexpected-success" };

  const output = `${result.stdout}\n${result.stderr}`;
  if (
    /operator\.admin|scope upgrade pending approval|device pairing required|pairing required/i.test(
      output,
    )
  ) {
    return { outcome: "approval-required" };
  }
  if (
    /gateway (?:connection )?(?:unavailable|unreachable)|econn(?:refused|reset)|connection refused|network unreachable|socket (?:closed|unavailable)/i.test(
      output,
    )
  ) {
    return { outcome: "gateway-unavailable" };
  }
  return { outcome: "command-failed" };
}

export function pendingAdminRequestId(result: PreApprovalAdminProbeResult): string | null {
  if (preApprovalAdminProbeEvidence(result).outcome !== "approval-required") return null;
  const requestIds = new Set(
    [
      ...`${result.stdout}\n${result.stderr}`.matchAll(
        /scope upgrade pending approval\s*\(requestId:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)/giu,
      ),
    ].map((match) => match[1]!.toLowerCase()),
  );
  return requestIds.size === 1 ? [...requestIds][0]! : null;
}
