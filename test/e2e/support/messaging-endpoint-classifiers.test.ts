// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseOpenClawAgentText } from "../live/messaging-compatible-endpoint-helpers.ts";
import { COMPAT_AGENT_PROMPT, COMPAT_AGENT_REPLY } from "./messaging-endpoint-classifiers.ts";

describe("messaging-compatible-endpoint live test local classifiers", () => {
  it("does not satisfy the agent reply assertion with echoed prompt text", () => {
    expect(COMPAT_AGENT_PROMPT).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_PROMPT } })),
    ).not.toContain(COMPAT_AGENT_REPLY);
    expect(
      parseOpenClawAgentText(JSON.stringify({ result: { content: COMPAT_AGENT_REPLY } })),
    ).toContain(COMPAT_AGENT_REPLY);
  });
});
