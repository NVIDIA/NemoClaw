// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shouldSmokeOpenAiLikeOnboardRoute } from "../src/lib/inference/onboard-probes";
import { runVerifyOnboardSmokeHarness } from "./helpers/onboard-smoke-verifier-harness";

describe("Hermes onboard smoke verification", () => {
  it("does not host-smoke Hermes Provider with the ambient OPENAI_API_KEY", () => {
    expect(shouldSmokeOpenAiLikeOnboardRoute("hermes-provider", "OPENAI_API_KEY")).toBe(false);
    expect(shouldSmokeOpenAiLikeOnboardRoute("hermes-provider", "NOUS_API_KEY")).toBe(true);
    expect(shouldSmokeOpenAiLikeOnboardRoute("openai-api")).toBe(true);
  });

  it("skips only the Hermes OAuth smoke path in the runtime verifier", async () => {
    const calls = await runVerifyOnboardSmokeHarness([
      { credentialEnv: "OPENAI_API_KEY" },
      { credentialEnv: "NOUS_API_KEY" },
      { credentialEnv: "OPENAI_API_KEY", forceOpenAiLike: true },
    ]);
    expect(
      calls.filter((call) =>
        ["resolveProviderCredential", "getCredential", "runCurlProbe"].includes(call[0]),
      ),
    ).toEqual([
      ["resolveProviderCredential", "NOUS_API_KEY"],
      [
        "runCurlProbe",
        "https://api.example.com/v1/chat/completions",
        "Authorization: Bearer resolved-NOUS_API_KEY",
      ],
      ["resolveProviderCredential", "OPENAI_API_KEY"],
      [
        "runCurlProbe",
        "https://api.example.com/v1/chat/completions",
        "Authorization: Bearer resolved-OPENAI_API_KEY",
      ],
    ]);
  });

  it("does not send a duplicate smoke request for a matching selected Chat Completions capability", async () => {
    const calls = await runVerifyOnboardSmokeHarness([
      {
        credentialEnv: "NOUS_API_KEY",
        endpointUrl: "https://override.example/v1",
        model: "override/model",
        provider: "hermes-provider",
        selectedChatCapability: true,
      },
    ]);

    expect(calls.filter((call) => call[0] === "runCurlProbe")).toHaveLength(0);
    expect(calls).toContainEqual([
      "log",
      "  ✓ Reusing selected Chat Completions validation: hermes-provider / override/model",
    ]);
  });

  it("fails when the selected capability cannot be safely cached", async () => {
    await expect(
      runVerifyOnboardSmokeHarness([
        {
          credentialEnv: "NOUS_API_KEY",
          endpointUrl: "https://api.example.com/v1?credential-bearing=true",
          selectedChatCapability: true,
        },
      ]),
    ).rejects.toThrow("failed to prime selected Chat Completions capability");
  });
});
