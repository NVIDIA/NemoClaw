// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure reply-assertion constants shared by the messaging-compatible-endpoint
// live E2E target and its PR-collected unit tests. Extracting the token
// constants lets the fast e2e-support project verify that the agent reply
// assertion cannot be satisfied by echoed prompt text without gating on
// NEMOCLAW_RUN_LIVE_E2E=1.

// Token the mock compatible endpoint returns and the agent turn must echo back.
export const COMPAT_AGENT_REPLY = "COMPAT_MOCK_ROUTE_5098_OK";
export const COMPAT_AGENT_PROMPT =
  "Call the configured model and report the compatible endpoint route token.";
