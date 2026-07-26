// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  agentReplyContainsToken,
  classifyPreContractProviderValidationSkip,
  parseChatContent,
  parseOpenClawAgentText,
} from "../live/common-egress-agent-helpers.ts";

describe("common-egress agent parsing and classification helpers", () => {
  it("OpenClaw JSON parser accepts framed agent payloads", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ payloads: [{ text: "noise" }, { text: "WEATHER_AGENT_OK" }] }),
      ),
    ).toContain("WEATHER_AGENT_OK");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ result: { payloads: [{ text: "REFERENCE_AGENT_OK" }] } }),
      ),
    ).toContain("REFERENCE_AGENT_OK");
    expect(
      parseOpenClawAgentText(
        `openclaw log line\n${JSON.stringify({
          result: { payloads: [{ text: "HERMES_REFERENCE_AGENT_OK" }] },
        })}\n`,
      ),
    ).toContain("HERMES_REFERENCE_AGENT_OK");
  });

  it("Hermes response parser reads message content", () => {
    expect(
      parseChatContent(
        JSON.stringify({ choices: [{ message: { content: "HERMES_REFERENCE_AGENT_OK" } }] }),
      ),
    ).toBe("HERMES_REFERENCE_AGENT_OK");
  });

  it("expected-token matching ignores model line breaks", () => {
    expect(agentReplyContainsToken("REFER\nENCE_AGENT_OK", "REFERENCE_AGENT_OK")).toBe(true);
    expect(
      agentReplyContainsToken("HERMES_REFERENCE\n_AGENT_OK", "HERMES_REFERENCE_AGENT_OK"),
    ).toBe(true);
  });

  it("classifies pre-contract provider validation skips", () => {
    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr:
          "NVIDIA Endpoints endpoint validation failed.\nChat Completions API validation returned HTTP 429",
      }),
    ).toMatchObject({
      http429ProviderValidationFailure: true,
      matches: true,
    });

    const originalGithubActions = process.env.GITHUB_ACTIONS;
    const restoreGithubActions = () => {
      delete process.env.GITHUB_ACTIONS;
      Object.assign(
        process.env,
        originalGithubActions === undefined ? {} : { GITHUB_ACTIONS: originalGithubActions },
      );
    };
    try {
      process.env.GITHUB_ACTIONS = "true";
      expect(
        classifyPreContractProviderValidationSkip({
          stdout: "",
          stderr:
            "NVIDIA Endpoints endpoint validation failed.\nValidation details were omitted to avoid exposing credentials.",
        }),
      ).toMatchObject({
        matches: true,
        sanitizedEndpointValidationFailure: true,
      });
    } finally {
      restoreGithubActions();
    }

    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr:
          "NVIDIA Endpoints endpoint validation failed.\ninvalid NVIDIA_INFERENCE_API_KEY credential",
      }),
    ).toMatchObject({ matches: false });
  });
});
