// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { requireHermesDiscordRestProof } from "../fixtures/hermes-discord-rest-proof.ts";

describe("Hermes Discord REST proof", () => {
  it.each([200, 401])("accepts a credential-bound users/@me response with status %i", (status) => {
    expect(
      requireHermesDiscordRestProof(`diagnostic\n${JSON.stringify({ statusCode: status })}`),
    ).toBe(status);
  });

  it.each([
    [
      "an invalid credential placeholder",
      '{"error":"invalid_token_placeholder"}',
      "invalid_token_placeholder",
    ],
    ["a timeout", '{"error":"timeout"}', "timeout"],
    ["an unexpected status", '{"statusCode":403}', "Unexpected Discord users/@me response: 403"],
    ["a missing result", "diagnostic only", "did not return a JSON result"],
  ])("rejects %s", (_case, stdout, expectedError) => {
    expect(() => requireHermesDiscordRestProof(stdout)).toThrow(expectedError);
  });
});
