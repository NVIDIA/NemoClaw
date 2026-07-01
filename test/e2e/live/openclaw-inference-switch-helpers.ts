// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure reply-matching helper shared by the openclaw-inference-switch live E2E
// target and its PR-collected unit test. Extracting the predicate lets the fast
// e2e-support project verify that a wrapped/whitespace-split "PONG" reply is
// accepted while echoed or embedded tokens are rejected, without gating on
// NEMOCLAW_RUN_LIVE_E2E=1.

export function agentReplyContainsToken(reply: string, expected: string): boolean {
  const normalizedReply = reply.replace(/\s+/gu, "").toUpperCase();
  const normalizedExpected = expected.replace(/\s+/gu, "").toUpperCase();
  return normalizedExpected.length > 0 && normalizedReply === normalizedExpected;
}
