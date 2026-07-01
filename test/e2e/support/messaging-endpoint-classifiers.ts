// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure reply-assertion helpers shared by the messaging-compatible-endpoint live
// E2E target and its PR-collected unit tests. Extracting the token constants and
// the reply predicate lets the fast e2e-support project verify that the agent
// reply assertion cannot be satisfied by echoed prompt text without gating on
// NEMOCLAW_RUN_LIVE_E2E=1.

import { parseOpenClawAgentText } from "../live/messaging-compatible-endpoint-helpers.ts";

// Token the mock compatible endpoint returns and the agent turn must echo back.
export const COMPAT_AGENT_REPLY = "COMPAT_MOCK_ROUTE_5098_OK";
export const COMPAT_AGENT_PROMPT =
  "Call the configured model and report the compatible endpoint route token.";

export function agentReplyContainsToken(
  agentStdout: string,
  replyToken: string = COMPAT_AGENT_REPLY,
): boolean {
  return parseOpenClawAgentText(agentStdout).includes(replyToken);
}
