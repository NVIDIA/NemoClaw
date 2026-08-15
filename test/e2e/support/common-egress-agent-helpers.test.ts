// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  agentReplyContainsToken,
  classifyPreContractProviderValidationSkip,
  isHermesTransientAgentFailure,
  parseChatContent,
  parseOpenClawAgentText,
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
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

  it("retries Hermes agent turns only for explicit transient failures", () => {
    expect(isHermesTransientAgentFailure("503", "service unavailable")).toBe(true);
    expect(isHermesTransientAgentFailure("000", "request failed: ECONNRESET")).toBe(true);
    expect(isHermesTransientAgentFailure("401", "unauthorized")).toBe(false);
    expect(isHermesTransientAgentFailure("200", "wrong deterministic answer")).toBe(false);
    expect(isHermesTransientAgentFailure("200", "reply mentions fetch failed")).toBe(false);
  });

  it("records recovered OpenClaw success after reconciliation", async () => {
    const onEvidence = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(true);
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        passed: false,
        failureClass: "transient-external",
        recoveryRequired: true,
      })
      .mockResolvedValueOnce({ passed: true });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      reconcile,
      run,
    });

    expect(result.outcome).toBe("passed");
    expect(onEvidence).toHaveBeenCalledWith({
      schemaVersion: 1,
      operation: "common-egress.openclaw-agent",
      owner: "openclaw-agent",
      idempotence: "reconciled-mutation",
      maxAttempts: 3,
      outcome: "passed-after-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "transient-external",
          reconciled: true,
          retryScheduled: true,
        },
        { attempt: 2, outcome: "passed", retryScheduled: false },
      ],
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ recoveryRequired: true }), 1);
  });

  it("records a deterministic Hermes failure without retrying", async () => {
    const onEvidence = vi.fn();
    const run = vi.fn().mockResolvedValue({ passed: false, failureClass: "deterministic" });

    const result = await runHermesAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(onEvidence).toHaveBeenCalledWith({
      schemaVersion: 1,
      operation: "common-egress.hermes-agent",
      owner: "hermes-agent",
      idempotence: "read-only",
      maxAttempts: 3,
      outcome: "failed-no-retry",
      attempts: [
        {
          attempt: 1,
          outcome: "failed",
          failureClass: "deterministic",
          retryScheduled: false,
        },
      ],
    });
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
