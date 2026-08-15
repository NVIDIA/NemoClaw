// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  agentReplyContainsToken,
  classifyHermesAgentAssertion,
  classifyOpenClawAgentAssertion,
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
    expect(isHermesTransientAgentFailure("401", "unauthorized after ECONNRESET")).toBe(false);
    expect(isHermesTransientAgentFailure("403", "authorization failed after ETIMEDOUT")).toBe(
      false,
    );
    expect(isHermesTransientAgentFailure("000", "authentication failed after ECONNRESET")).toBe(
      false,
    );
    expect(isHermesTransientAgentFailure("503", "authentication failed upstream")).toBe(false);
    expect(isHermesTransientAgentFailure("400", "request failed: ECONNRESET")).toBe(false);
    expect(isHermesTransientAgentFailure("200", "wrong deterministic answer")).toBe(false);
    expect(isHermesTransientAgentFailure("200", "reply mentions fetch failed")).toBe(false);
  });

  it("classifies OpenClaw agent results for bounded retry", () => {
    const result = {
      exitCode: 1,
      expected: "REFERENCE_AGENT_OK",
      reply: "wrong answer",
      response: "wrong answer",
    };

    expect(
      classifyOpenClawAgentAssertion({ ...result, exitCode: 0, reply: "REFERENCE_AGENT_OK" }),
    ).toEqual({ passed: true });
    expect(classifyOpenClawAgentAssertion({ ...result, response: "Blocked hostname" })).toEqual({
      passed: false,
      failureClass: "policy-denial",
    });
    expect(classifyOpenClawAgentAssertion({ ...result, response: "HTTP 401" })).toEqual({
      passed: false,
      failureClass: "authentication",
    });
    expect(classifyOpenClawAgentAssertion({ ...result, response: "HTTP 403" })).toEqual({
      passed: false,
      failureClass: "authorization",
    });
    expect(
      classifyOpenClawAgentAssertion({
        ...result,
        response: "authentication failed after timeout",
      }),
    ).toEqual({ passed: false, failureClass: "authentication" });
    expect(
      classifyOpenClawAgentAssertion({
        ...result,
        response: "authorization failed after ECONNRESET",
      }),
    ).toEqual({ passed: false, failureClass: "authorization" });
    expect(
      classifyOpenClawAgentAssertion({
        ...result,
        response: "denied by network policy after timeout",
      }),
    ).toEqual({ passed: false, failureClass: "policy-denial" });
    expect(
      classifyOpenClawAgentAssertion({ ...result, response: "malformed request after ETIMEDOUT" }),
    ).toEqual({ passed: false, failureClass: "malformed-input" });
    expect(
      classifyOpenClawAgentAssertion({ ...result, response: "request failed: ECONNRESET" }),
    ).toEqual({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: false,
    });
    expect(
      classifyOpenClawAgentAssertion({
        ...result,
        exitCode: 0,
        response: "wrong product reply mentioning fetch failed and ETIMEDOUT",
      }),
    ).toEqual({
      passed: false,
      failureClass: "deterministic",
      recoveryRequired: false,
    });
    expect(
      classifyOpenClawAgentAssertion({ ...result, response: "scope upgrade pending approval" }),
    ).toEqual({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: true,
    });
    expect(classifyOpenClawAgentAssertion(result)).toEqual({
      passed: false,
      failureClass: "deterministic",
      recoveryRequired: false,
    });
  });

  it("classifies Hermes agent results for bounded retry", () => {
    const result = {
      exitCode: 1,
      expected: "HERMES_REFERENCE_AGENT_OK",
      httpStatus: "200",
      reply: "wrong answer",
      response: "wrong answer",
    };

    expect(
      classifyHermesAgentAssertion({
        ...result,
        exitCode: 0,
        reply: "HERMES_REFERENCE_AGENT_OK",
      }),
    ).toEqual({ passed: true });
    expect(classifyHermesAgentAssertion({ ...result, httpStatus: "401" })).toEqual({
      passed: false,
      failureClass: "authentication",
    });
    expect(classifyHermesAgentAssertion({ ...result, httpStatus: "403" })).toEqual({
      passed: false,
      failureClass: "authorization",
    });
    expect(classifyHermesAgentAssertion({ ...result, httpStatus: "503" })).toEqual({
      passed: false,
      failureClass: "transient-external",
    });
    expect(
      classifyHermesAgentAssertion({
        ...result,
        httpStatus: "503",
        response: "authentication failed after timeout",
      }),
    ).toEqual({ passed: false, failureClass: "authentication" });
    expect(
      classifyHermesAgentAssertion({
        ...result,
        httpStatus: "000",
        response: "authorization failed after ECONNRESET",
      }),
    ).toEqual({ passed: false, failureClass: "authorization" });
    expect(
      classifyHermesAgentAssertion({
        ...result,
        httpStatus: "000",
        response: "denied by network policy after timeout",
      }),
    ).toEqual({ passed: false, failureClass: "policy-denial" });
    expect(
      classifyHermesAgentAssertion({
        ...result,
        httpStatus: "000",
        response: "malformed request after ETIMEDOUT",
      }),
    ).toEqual({ passed: false, failureClass: "malformed-input" });
    expect(classifyHermesAgentAssertion(result)).toEqual({
      passed: false,
      failureClass: "deterministic",
    });
  });

  it("records OpenClaw success after the required scope recovery", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(true);
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
      recover,
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
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ recoveryRequired: true }), 1);
  });

  it("does not retry a plain OpenClaw transport failure without reconciliation", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(true);
    const run = vi
      .fn()
      .mockResolvedValueOnce({ passed: false, failureClass: "transient-external" })
      .mockResolvedValueOnce({ passed: true });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    expect(onEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotence: "reconciled-mutation",
        outcome: "failed-no-retry",
        attempts: [
          {
            attempt: 1,
            outcome: "failed",
            failureClass: "transient-external",
            reconciled: false,
            retryScheduled: false,
          },
        ],
      }),
    );
  });

  it("does not retry when OpenClaw scope recovery fails", async () => {
    const onEvidence = vi.fn();
    const recover = vi.fn().mockResolvedValue(false);
    const run = vi.fn().mockResolvedValue({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: true,
    });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence,
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(result.evidence.attempts).toEqual([
      expect.objectContaining({ reconciled: false, retryScheduled: false }),
    ]);
  });

  it("does not retry when OpenClaw scope recovery throws", async () => {
    const recover = vi.fn().mockRejectedValue(new Error("recovery unavailable"));
    const run = vi.fn().mockResolvedValue({
      passed: false,
      failureClass: "transient-external",
      recoveryRequired: true,
    });

    const result = await runOpenClawAgentAssertionRetry({
      attempts: 3,
      delayMs: () => 0,
      onEvidence: vi.fn(),
      recover,
      run,
    });

    expect(result.outcome).toBe("failed");
    expect(run).toHaveBeenCalledOnce();
    expect(result.evidence.attempts).toEqual([
      expect.objectContaining({ reconciled: false, retryScheduled: false }),
    ]);
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
    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr: "endpoint validation failed: authentication failed after HTTP 429 rate limit",
      }),
    ).toMatchObject({
      http429ProviderValidationFailure: false,
      matches: false,
      transientProviderValidationFailure: false,
    });
    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr: "endpoint validation failed: denied by network policy after timeout",
      }),
    ).toMatchObject({ matches: false, transientProviderValidationFailure: false });
    expect(
      classifyPreContractProviderValidationSkip({
        stdout: "",
        stderr: "endpoint validation failed: invalid JSON request after HTTP 429 timeout",
      }),
    ).toMatchObject({
      http429ProviderValidationFailure: false,
      matches: false,
      transientProviderValidationFailure: false,
    });
  });
});
