// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { requireInferenceLocalCompletionText } from "../live/network-policy-inference.ts";

describe("network-policy inference.local completion proof", () => {
  it("accepts final assistant content", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: " PONG " } }] });

    expect(requireInferenceLocalCompletionText(raw)).toBe("PONG");
  });

  it("accepts reasoning-only output when final content is null", () => {
    const raw = JSON.stringify({
      choices: [
        {
          finish_reason: "length",
          message: { content: null, reasoning_content: "The requested answer is PONG." },
        },
      ],
    });

    expect(requireInferenceLocalCompletionText(raw)).toBe("The requested answer is PONG.");
  });

  it("rejects a response without completion or reasoning text", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: null } }] });

    expect(() => requireInferenceLocalCompletionText(raw)).toThrow(
      "inference.local response did not contain non-empty content or reasoning text",
    );
  });

  it("rejects a non-JSON response", () => {
    expect(() => requireInferenceLocalCompletionText("upstream unavailable")).toThrow(
      "inference.local response was not valid JSON",
    );
  });
});
