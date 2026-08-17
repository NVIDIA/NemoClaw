// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  agentReplyContainsToken,
  assessPersonalStockToolEvidence,
  buildOpenClawToolEvidenceReducerScript,
  classifyHermesAgentAssertion,
  classifyOpenClawAgentAssertion,
  classifyPreContractProviderValidationSkip,
  isHermesTransientAgentFailure,
  nvdaPersonalStockReplyMatchesEvidence,
  parseChatContent,
  parseNvdaPersonalStockReply,
  parseOpenClawAgentText,
  parseOpenClawToolEvidence,
  reduceOpenClawToolEvidence,
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
  type NvdaPersonalStockReply,
  type OpenClawAgentAttemptEvidenceOptions,
  validateOpenClawAgentAttemptEvidence,
} from "../live/common-egress-agent-helpers.ts";

const STOCK_SOURCE_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?credential=must-not-remain";
const STOCK_REPLY = {
  status: "NVDA_PERSONAL_AGENT_OK",
  symbol: "NVDA",
  price: 192.38,
  source_url: STOCK_SOURCE_URL,
  as_of: "2026-08-17T15:59:00Z",
} satisfies NvdaPersonalStockReply;

function stockPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: STOCK_SOURCE_URL,
    finalUrl: STOCK_SOURCE_URL,
    status: 200,
    contentType: "application/json",
    extractor: "json",
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
    fetchedAt: "2026-08-17T16:00:00Z",
    text: '{"symbol":"NVDA","regularMarketPrice":192.38,"regularMarketTime":1786982340}',
    ...overrides,
  };
}

function stockSessionJsonLines(
  options: {
    callId?: string;
    details?: Record<string, unknown>;
    extraToolName?: string;
    isError?: boolean;
    payload?: Record<string, unknown>;
    resultCallId?: string;
    resultToolName?: string;
  } = {},
): string {
  const callId = options.callId ?? "call-web-fetch-1";
  const payload = options.payload ?? stockPayload();
  const content = [
    {
      type: "toolCall",
      id: callId,
      name: "web_fetch",
      arguments: { url: STOCK_SOURCE_URL, maxChars: 8_000 },
    },
    ...(options.extraToolName
      ? [{ type: "toolCall", id: "call-extra-1", name: options.extraToolName, arguments: {} }]
      : []),
  ];
  return [
    JSON.stringify({ type: "message", message: { role: "assistant", content } }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: options.resultCallId ?? callId,
        toolName: options.resultToolName ?? "web_fetch",
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: options.details ?? payload,
        isError: options.isError ?? false,
      },
    }),
  ].join("\n");
}

function stockTrajectory(extraToolName?: string): string {
  return JSON.stringify({
    type: "trace.artifacts",
    data: {
      finalStatus: "success",
      toolMetas: [
        { toolName: "web_fetch", meta: STOCK_SOURCE_URL },
        ...(extraToolName ? [{ toolName: extraToolName, meta: {} }] : []),
      ],
    },
  });
}

function stockAttemptValidationOptions(
  overrides: Partial<OpenClawAgentAttemptEvidenceOptions> = {},
): OpenClawAgentAttemptEvidenceOptions {
  const evidence = reduceOpenClawToolEvidence(
    stockSessionJsonLines(),
    stockTrajectory(),
    STOCK_REPLY,
  );
  return {
    classification: { passed: true },
    label: "personal-stock",
    recordToolEvidence: vi.fn().mockResolvedValue(undefined),
    reduceToolEvidence: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: `__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
    }),
    reply: JSON.stringify(STOCK_REPLY),
    replyValidator: (reply, evidence) =>
      evidence !== undefined && nvdaPersonalStockReplyMatchesEvidence(reply, evidence),
    toolEvidenceValidator: (candidate) => assessPersonalStockToolEvidence(candidate).matches,
    ...overrides,
  };
}

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

  it("reduces OpenClaw stock-fetch traces without retaining fetched content or URL queries", () => {
    const source = "query1.finance.yahoo.com";
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines(),
      stockTrajectory(),
      STOCK_REPLY,
    );

    expect(evidence).toEqual({
      schemaVersion: 1,
      errors: [],
      expectedStockFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/u),
      finalStatuses: ["success"],
      providerMentions: [],
      toolCalls: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolExecutions: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolResults: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      webFetchResults: [
        {
          asOfMatches: true,
          directFetch: true,
          httpSuccess: true,
          paired: true,
          priceMatches: true,
          resultSuccess: true,
          sourceUrlMatches: true,
          symbolMatches: true,
          target: { hostname: source, protocol: "https:" },
        },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("credential");
    expect(JSON.stringify(evidence)).not.toContain("regularMarketPrice");
    expect(JSON.stringify(evidence)).not.toContain("192.38");
    expect(JSON.stringify(evidence)).not.toContain("/v8/finance/chart");
    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: [],
      forbiddenToolNames: [],
      matches: true,
      qualifyingWebFetchResults: 1,
      webFetchCalls: 1,
      webFetchExecutions: 1,
    });
    expect(
      parseOpenClawToolEvidence(
        `log line\n__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
      ),
    ).toEqual(evidence);
    expect(buildOpenClawToolEvidenceReducerScript(STOCK_REPLY)).toContain(
      "__NEMOCLAW_TOOL_EVIDENCE__=",
    );
  });

  it("executes the generated reducer script against OpenClaw JSONL artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-reducer-"));
    try {
      const sessionPath = join(directory, "session.jsonl");
      const trajectoryPath = join(directory, "trajectory.jsonl");
      writeFileSync(sessionPath, `${stockSessionJsonLines()}\n`);
      writeFileSync(trajectoryPath, `${stockTrajectory()}\n`);

      const result = spawnSync(
        process.execPath,
        ["-e", buildOpenClawToolEvidenceReducerScript(STOCK_REPLY), sessionPath, trajectoryPath],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(parseOpenClawToolEvidence(result.stdout)).toMatchObject({
        errors: [],
        finalStatuses: ["success"],
        toolCalls: [{ name: "web_fetch", target: { hostname: "query1.finance.yahoo.com" } }],
        toolExecutions: [{ name: "web_fetch", target: { hostname: "query1.finance.yahoo.com" } }],
        toolResults: [{ name: "web_fetch", target: { hostname: "query1.finance.yahoo.com" } }],
        webFetchResults: [
          expect.objectContaining({
            directFetch: true,
            paired: true,
            priceMatches: true,
            resultSuccess: true,
            sourceUrlMatches: true,
          }),
        ],
      });
      expect(result.stdout).not.toContain("credential");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("validates and records a successful Personal stock-fetch attempt", async () => {
    const recordToolEvidence = vi.fn().mockResolvedValue(undefined);
    const reduceToolEvidence = vi
      .fn()
      .mockImplementation(stockAttemptValidationOptions().reduceToolEvidence);
    const result = await validateOpenClawAgentAttemptEvidence(
      stockAttemptValidationOptions({ recordToolEvidence, reduceToolEvidence }),
    );

    expect(result).toMatchObject({
      attempt: { passed: true },
      evidence: {
        reply: JSON.stringify(STOCK_REPLY),
        toolEvidence: { errors: [], finalStatuses: ["success"] },
      },
    });
    expect(reduceToolEvidence).toHaveBeenCalledWith(STOCK_REPLY);
    expect(recordToolEvidence).toHaveBeenCalledWith(result.evidence?.toolEvidence);
  });

  it("preserves a failed OpenClaw classification before evidence collection", async () => {
    const reduceToolEvidence = vi.fn();
    const result = await validateOpenClawAgentAttemptEvidence(
      stockAttemptValidationOptions({
        classification: {
          passed: false,
          failureClass: "transient-external",
          recoveryRequired: true,
        },
        reduceToolEvidence,
      }),
    );

    expect(result).toEqual({
      attempt: {
        passed: false,
        failureClass: "transient-external",
        recoveryRequired: true,
      },
    });
    expect(reduceToolEvidence).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an invalid stock reply",
      overrides: { reply: "not stock JSON" },
      failure: /did not contain a valid stock quote/u,
    },
    {
      name: "a reducer command failure",
      overrides: {
        reduceToolEvidence: vi.fn().mockResolvedValue({ exitCode: 2, stdout: "" }),
      },
      failure: /reduced tool evidence exited with 2/u,
    },
    {
      name: "malformed reduced evidence",
      overrides: {
        reduceToolEvidence: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "no marker" }),
      },
      failure: /reduced tool evidence marker is missing/u,
    },
    {
      name: "a trajectory mismatch",
      overrides: { toolEvidenceValidator: () => false },
      failure: /did not match the required trajectory/u,
    },
    {
      name: "a reply mismatch",
      overrides: { replyValidator: () => false },
      failure: /did not contain a recent fetched stock quote/u,
    },
  ])("rejects $name deterministically", async ({ overrides, failure }) => {
    const result = await validateOpenClawAgentAttemptEvidence(
      stockAttemptValidationOptions(overrides),
    );

    expect(result.attempt).toEqual({ passed: false, failureClass: "deterministic" });
    expect(result.failure).toMatch(failure);
    expect(result.evidence).toBeUndefined();
  });

  it("uses parseable tool-result text when persisted OpenClaw details are capped", () => {
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines({ details: { persistedDetailsTruncated: true } }),
      stockTrajectory(),
      STOCK_REPLY,
    );

    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      matches: true,
      qualifyingWebFetchResults: 1,
    });
  });

  it("rejects search-provider and non-public stock-fetch trajectories", () => {
    const evidence = reduceOpenClawToolEvidence(
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "web_search",
                arguments: { provider: "brave", query: "NVDA price" },
              },
              {
                type: "toolCall",
                name: "web_fetch",
                arguments: { url: "http://169.254.169.254/latest/meta-data/" },
              },
            ],
          },
        }),
        "not-json",
      ].join("\n"),
      JSON.stringify({
        type: "trace.artifacts",
        data: {
          finalStatus: "success",
          toolMetas: [
            { toolName: "web_search", meta: { provider: "tavily" } },
            { toolName: "web_fetch", meta: "http://169.254.169.254/latest/meta-data/" },
          ],
        },
      }),
    );

    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: ["brave", "tavily"],
      forbiddenToolNames: ["web_search"],
      matches: false,
      publicHttpsTargets: [],
    });
    expect(evidence.errors).toEqual(["session line 2 is not JSON"]);
  });

  it("accepts a recent numeric NVDA reply only when one paired fetch result supports it", () => {
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines(),
      stockTrajectory(),
      STOCK_REPLY,
    );
    const reply = JSON.stringify(STOCK_REPLY);

    expect(parseNvdaPersonalStockReply(`\`\`\`json\n${reply}\n\`\`\``)).toMatchObject({
      price: 192.38,
      source_url: STOCK_SOURCE_URL,
      symbol: "NVDA",
    });
    expect(
      parseNvdaPersonalStockReply(
        JSON.stringify({ ...STOCK_REPLY, source_url: "https://10.0.0.1/quote/NVDA" }),
      ),
    ).toBeNull();
    expect(
      parseNvdaPersonalStockReply(
        JSON.stringify({ ...STOCK_REPLY, source_url: "https://[fd00::1]/quote/NVDA" }),
      ),
    ).toBeNull();
    expect(
      nvdaPersonalStockReplyMatchesEvidence(reply, evidence, Date.parse("2026-08-18T12:00:00Z")),
    ).toBe(true);
    expect(
      nvdaPersonalStockReplyMatchesEvidence(
        reply.replace("/v8/finance/chart/NVDA", "/v8/finance/chart/AMD"),
        evidence,
        Date.parse("2026-08-18T12:00:00Z"),
      ),
    ).toBe(false);
    expect(
      nvdaPersonalStockReplyMatchesEvidence(reply, evidence, Date.parse("2026-09-01T12:00:00Z")),
    ).toBe(false);
    expect(
      nvdaPersonalStockReplyMatchesEvidence(
        reply.replace('"NVDA"', '"AMD"'),
        evidence,
        Date.parse("2026-08-18T12:00:00Z"),
      ),
    ).toBe(false);
  });

  it.each([
    "https://[::ffff:127.0.0.1]/quote/NVDA",
    "https://[::ffff:169.254.169.254]/quote/NVDA",
    "https://[::ffff:10.0.0.1]/quote/NVDA",
    "https://[::ffff:192.168.1.2]/quote/NVDA",
  ])("rejects an IPv4-mapped internal stock source: %s", (source_url) => {
    expect(parseNvdaPersonalStockReply(JSON.stringify({ ...STOCK_REPLY, source_url }))).toBeNull();
  });

  it.each([
    {
      name: "failed tool result followed by a fabricated reply",
      session: stockSessionJsonLines({ isError: true }),
      trajectory: stockTrajectory(),
      expected: STOCK_REPLY,
    },
    {
      name: "unrelated content fetched from the claimed host",
      session: stockSessionJsonLines({
        payload: stockPayload({ text: "Public finance landing page, updated 2026-08-17." }),
      }),
      trajectory: stockTrajectory(),
      expected: STOCK_REPLY,
    },
    {
      name: "provider fallback result",
      session: stockSessionJsonLines({
        payload: stockPayload({
          extractor: "firecrawl",
          externalContent: {
            untrusted: true,
            source: "web_fetch",
            provider: "firecrawl",
            wrapped: true,
          },
        }),
      }),
      trajectory: stockTrajectory(),
      expected: STOCK_REPLY,
    },
    {
      name: "mismatched tool call id",
      session: stockSessionJsonLines({ resultCallId: "call-web-fetch-other" }),
      trajectory: stockTrajectory(),
      expected: STOCK_REPLY,
    },
    {
      name: "dummy fetch plus another tool",
      session: stockSessionJsonLines({ extraToolName: "exec" }),
      trajectory: stockTrajectory("exec"),
      expected: STOCK_REPLY,
    },
    {
      name: "fetch content without the claimed price or date",
      session: stockSessionJsonLines({ payload: stockPayload({ text: "NVDA quote unavailable" }) }),
      trajectory: stockTrajectory(),
      expected: STOCK_REPLY,
    },
  ])("rejects $name", ({ expected, session, trajectory }) => {
    const evidence = reduceOpenClawToolEvidence(session, trajectory, expected);

    expect(assessPersonalStockToolEvidence(evidence).matches).toBe(false);
    expect(
      nvdaPersonalStockReplyMatchesEvidence(
        JSON.stringify(expected),
        evidence,
        Date.parse("2026-08-18T12:00:00Z"),
      ),
    ).toBe(false);
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
