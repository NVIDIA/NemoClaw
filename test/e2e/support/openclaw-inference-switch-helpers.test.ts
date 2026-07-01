// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { agentReplyContainsToken } from "../live/openclaw-inference-switch-helpers.ts";

describe("openclaw-inference-switch agent reply matching", () => {
  it("tolerates wrapped PONG", () => {
    expect(agentReplyContainsToken("P\nO N G", "PONG")).toBe(true);
    expect(agentReplyContainsToken("wrapped: p o\nng", "PONG")).toBe(false);
    expect(agentReplyContainsToken("the answer is PONG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PONG because the route works", "PONG")).toBe(false);
    expect(agentReplyContainsToken("PANG", "PONG")).toBe(false);
    expect(agentReplyContainsToken("SPONGE", "PONG")).toBe(false);
    expect(agentReplyContainsToken("pingpong", "PONG")).toBe(false);
  });
});
