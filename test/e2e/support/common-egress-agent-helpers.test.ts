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
  projectNvdaPersonalStockReplyEvidence,
  projectPersonalStockToolEvidenceArtifact,
  reduceOpenClawToolEvidence,
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
  type NvdaPersonalStockReply,
  type OpenClawAgentAttemptEvidenceOptions,
  type OpenClawToolEvidence,
  type PersonalStockToolEvidenceArtifact,
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
    maxChars?: number | null;
    payload?: Record<string, unknown>;
    resultCallId?: string;
    resultToolName?: string;
  } = {},
): string {
  const callId = options.callId ?? "call-web-fetch-1";
  const payload = options.payload ?? stockPayload();
  const maxChars = options.maxChars === undefined ? 8_000 : options.maxChars;
  const content = [
    {
      type: "toolCall",
      id: callId,
      name: "web_fetch",
      arguments: { url: STOCK_SOURCE_URL, ...(maxChars === null ? {} : { maxChars }) },
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

function directStockTrajectoryWithProjection(): string {
  const messagesSnapshot = stockSessionJsonLines()
    .split("\n")
    .map((line) => (JSON.parse(line) as { message: unknown }).message);
  return [
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot } }),
    stockTrajectory(),
  ].join("\n");
}

function progressiveStockSessionJsonLines(
  options: { maxChars?: number | null; wrapperTargetId?: string } = {},
): string {
  const maxChars = options.maxChars === undefined ? 8_000 : options.maxChars;
  const calls = [
    { id: "call-search-1", name: "tool_search", arguments: { query: "web fetch" } },
    {
      id: "call-describe-1",
      name: "tool_describe",
      arguments: { id: "openclaw:core:web_fetch" },
    },
    {
      id: "call-wrapper-1",
      name: "tool_call",
      arguments: {
        id: options.wrapperTargetId ?? "openclaw:core:web_fetch",
        args: { url: STOCK_SOURCE_URL, ...(maxChars === null ? {} : { maxChars }) },
      },
    },
  ];
  return calls
    .flatMap((call) => [
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", ...call }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "{}" }],
          isError: false,
        },
      }),
    ])
    .join("\n");
}

function progressiveStockTrajectory(
  options: {
    maxChars?: number | null;
    payload?: Record<string, unknown>;
    projectedParentCallId?: string;
    projectedTargetName?: string;
    wrapperTargetId?: string;
  } = {},
): string {
  const payload = options.payload ?? stockPayload();
  const projectedTargetName = options.projectedTargetName ?? "web_fetch";
  const maxChars = options.maxChars === undefined ? 8_000 : options.maxChars;
  const targetArguments = {
    url: STOCK_SOURCE_URL,
    ...(maxChars === null ? {} : { maxChars }),
  };
  const sessionMessages = progressiveStockSessionJsonLines(options)
    .split("\n")
    .map((line) => (JSON.parse(line) as { message: unknown }).message);
  const targetCallId = `tool_search_code:${
    options.projectedParentCallId ?? "call-wrapper-1"
  }:${projectedTargetName}:1`;
  const messagesSnapshot = [
    ...sessionMessages,
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: targetCallId,
          name: projectedTargetName,
          arguments: targetArguments,
          input: targetArguments,
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: targetCallId,
      toolName: projectedTargetName,
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: false,
    },
  ];
  return [
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot } }),
    JSON.stringify({
      type: "trace.artifacts",
      data: {
        finalStatus: "success",
        toolMetas: [
          { toolName: "tool_search", meta: {} },
          { toolName: "tool_describe", meta: {} },
          { toolName: projectedTargetName, meta: STOCK_SOURCE_URL },
          { toolName: "tool_call", meta: {} },
        ],
      },
    }),
  ].join("\n");
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
      evidence !== undefined &&
      nvdaPersonalStockReplyMatchesEvidence(reply, evidence, Date.parse(STOCK_REPLY.as_of)),
    toolEvidenceValidator: (candidate) => assessPersonalStockToolEvidence(candidate).matches,
    ...overrides,
  };
}

async function expectAggregateStockFailure(
  evidence: OpenClawToolEvidence,
  countName: keyof PersonalStockToolEvidenceArtifact["webFetchResultCounts"],
): Promise<void> {
  const artifact = projectPersonalStockToolEvidenceArtifact(evidence);
  const result = await validateOpenClawAgentAttemptEvidence(
    stockAttemptValidationOptions({
      reduceToolEvidence: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: `__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
      }),
      toolEvidenceValidator: () => false,
    }),
  );

  expect(artifact.webFetchResultCounts).toMatchObject({ total: 1, [countName]: 0 });
  expect(artifact.qualifyingWebFetchResults).toBe(0);
  expect(result.failure).toContain(`${countName}=0`);
  for (const sensitiveValue of [
    STOCK_SOURCE_URL,
    String(STOCK_REPLY.price),
    STOCK_REPLY.as_of,
    stockPayload().text as string,
    evidence.expectedStockFingerprint!,
    "must-not-remain",
    "web_fetch",
  ]) {
    expect(JSON.stringify(artifact)).not.toContain(sensitiveValue);
    expect(result.failure).not.toContain(sensitiveValue);
  }
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
      controlTargetViolations: 0,
      errors: [],
      expectedStockFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/u),
      finalStatuses: ["success"],
      projectedTargetEvidence: false,
      providerMentions: [],
      toolCalls: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolExecutions: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolResults: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      webFetchResults: [
        {
          asOfMatches: true,
          directFetch: true,
          httpSuccess: true,
          maxCharsWithinLimit: true,
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

  it("uses a direct-call model snapshot for complete results without granting control tools", () => {
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines({
        details: { persistedDetailsTruncated: true },
        payload: stockPayload({ text: "persisted result was truncated" }),
      }),
      directStockTrajectoryWithProjection(),
      STOCK_REPLY,
    );

    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      forbiddenToolNames: [],
      matches: true,
      projectedTargetEvidence: false,
      qualifyingWebFetchResults: 1,
    });
  });

  it("accepts a progressive Tool Search wrapper only with projected web_fetch proof", () => {
    const evidence = reduceOpenClawToolEvidence(
      progressiveStockSessionJsonLines(),
      progressiveStockTrajectory(),
      STOCK_REPLY,
    );

    expect(evidence.errors).toEqual([]);
    expect(evidence).toMatchObject({
      controlTargetViolations: 0,
      projectedTargetEvidence: true,
    });
    expect(evidence.toolCalls.map(({ name }) => name)).toEqual([
      "tool_search",
      "tool_describe",
      "tool_call",
      "web_fetch",
    ]);
    expect(evidence.toolExecutions.map(({ name }) => name)).toEqual([
      "tool_search",
      "tool_describe",
      "web_fetch",
      "tool_call",
    ]);
    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: [],
      forbiddenToolNames: [],
      matches: true,
      qualifyingWebFetchResults: 1,
      webFetchCalls: 1,
      webFetchExecutions: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("credential");
    expect(JSON.stringify(evidence)).not.toContain("192.38");
  });

  it("rejects progressive controls without a projected target call and result", () => {
    const trajectory = progressiveStockTrajectory()
      .split("\n")
      .map((line) => JSON.parse(line) as { data?: Record<string, unknown>; type?: string })
      .map((event) =>
        JSON.stringify(
          event.type === "model.completed" && event.data
            ? {
                ...event,
                data: {
                  ...event.data,
                  messagesSnapshot: (
                    event.data.messagesSnapshot as Array<{
                      content?: Array<{ name?: string }>;
                    }>
                  ).filter((message) => message.content?.[0]?.name !== "web_fetch"),
                },
              }
            : event,
        ),
      )
      .join("\n");
    const evidence = reduceOpenClawToolEvidence(
      progressiveStockSessionJsonLines(),
      trajectory,
      STOCK_REPLY,
    );

    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 0,
      webFetchCalls: 0,
    });
  });

  it("rejects fallback controls that target exec beside an otherwise valid direct fetch", () => {
    const evidence = reduceOpenClawToolEvidence(
      [
        stockSessionJsonLines(),
        progressiveStockSessionJsonLines({ wrapperTargetId: "openclaw:core:exec" }),
      ].join("\n"),
      stockTrajectory("tool_call"),
      STOCK_REPLY,
    );

    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      controlTargetViolations: 1,
      forbiddenToolNames: ["tool_call", "tool_describe", "tool_search"],
      matches: false,
      projectedTargetEvidence: false,
      qualifyingWebFetchResults: 1,
    });
  });

  it.each([
    {
      name: "an oversized direct fetch",
      session: stockSessionJsonLines({ maxChars: 8_001 }),
      trajectory: stockTrajectory(),
    },
    {
      name: "an oversized progressive fetch",
      session: progressiveStockSessionJsonLines({ maxChars: 8_001 }),
      trajectory: progressiveStockTrajectory({ maxChars: 8_001 }),
    },
    {
      name: "a direct fetch that omits maxChars",
      session: stockSessionJsonLines({ maxChars: null }),
      trajectory: stockTrajectory(),
    },
  ])("rejects $name", ({ session, trajectory }) => {
    const evidence = reduceOpenClawToolEvidence(session, trajectory, STOCK_REPLY);

    expect(evidence.webFetchResults).toContainEqual(
      expect.objectContaining({ maxCharsWithinLimit: false }),
    );
    expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 0,
    });
  });

  it.each([
    { name: "a forbidden projected target", projectedTargetName: "exec", payload: stockPayload() },
    {
      name: "a provider-backed projected fetch",
      projectedTargetName: "web_fetch",
      payload: stockPayload({
        extractor: "firecrawl",
        externalContent: {
          untrusted: true,
          source: "web_fetch",
          provider: "firecrawl",
          wrapped: true,
        },
      }),
    },
  ])("rejects $name behind progressive controls", ({ payload, projectedTargetName }) => {
    const evidence = reduceOpenClawToolEvidence(
      progressiveStockSessionJsonLines(),
      progressiveStockTrajectory({ payload, projectedTargetName }),
      STOCK_REPLY,
    );

    expect(assessPersonalStockToolEvidence(evidence).matches).toBe(false);
  });

  it.each([
    {
      controlTargetViolations: 1,
      name: "a non-core catalog alias",
      projectedParentCallId: "call-wrapper-1",
      wrapperTargetId: "mcp:evil:web_fetch",
    },
    {
      controlTargetViolations: 0,
      name: "an unassociated projected call",
      projectedParentCallId: "unrelated-call",
      wrapperTargetId: "openclaw:core:web_fetch",
    },
  ])(
    "rejects $name even with a complete projected web_fetch result",
    ({ controlTargetViolations, projectedParentCallId, wrapperTargetId }) => {
      const evidence = reduceOpenClawToolEvidence(
        progressiveStockSessionJsonLines({ wrapperTargetId }),
        progressiveStockTrajectory({ projectedParentCallId, wrapperTargetId }),
        STOCK_REPLY,
      );

      expect(assessPersonalStockToolEvidence(evidence)).toMatchObject({
        controlTargetViolations,
        matches: false,
        projectedTargetEvidence: false,
      });
    },
  );

  it("projects upload-safe stock evidence and keeps failure diagnostics aggregate-only", async () => {
    const providerSentinel = "provider-secret-sentinel";
    const toolSentinel = "tool-secret-sentinel";
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines({
        extraToolName: toolSentinel,
        payload: stockPayload({
          extractor: "firecrawl",
          externalContent: {
            untrusted: true,
            source: "web_fetch",
            provider: providerSentinel,
            wrapped: true,
          },
        }),
      }),
      stockTrajectory(toolSentinel),
      STOCK_REPLY,
    );
    const artifact = projectPersonalStockToolEvidenceArtifact(evidence);
    const serialized = JSON.stringify(artifact);

    expect(artifact).toMatchObject({
      errorCount: 0,
      finalSuccess: true,
      forbiddenProviderMentionCount: 1,
      forbiddenToolCount: 1,
      matches: false,
      publicHttpsTargets: [{ hostname: "query1.finance.yahoo.com", protocol: "https:" }],
      webFetchResultCounts: {
        asOfMatches: 1,
        directFetch: 0,
        httpSuccess: 1,
        maxCharsWithinLimit: 1,
        paired: 1,
        priceMatches: 1,
        publicHttpsTarget: 1,
        resultSuccess: 1,
        sourceUrlMatches: 1,
        symbolMatches: 1,
        total: 1,
      },
    });
    expect(serialized).not.toContain(providerSentinel);
    expect(serialized).not.toContain(toolSentinel);
    expect(serialized).not.toContain("credential");
    expect(evidence.expectedStockFingerprint).not.toBeNull();
    expect(serialized).not.toContain(evidence.expectedStockFingerprint!);

    const result = await validateOpenClawAgentAttemptEvidence(
      stockAttemptValidationOptions({
        reduceToolEvidence: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: `__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
        }),
        toolEvidenceValidator: () => false,
      }),
    );
    expect(result.failure).toContain("forbiddenTools=1; forbiddenProviders=1");
    expect(result.failure).not.toContain(providerSentinel);
    expect(result.failure).not.toContain(toolSentinel);
  });

  it.each([
    { predicate: "asOfMatches", countName: "asOfMatches" },
    { predicate: "directFetch", countName: "directFetch" },
    { predicate: "httpSuccess", countName: "httpSuccess" },
    { predicate: "maxCharsWithinLimit", countName: "maxCharsWithinLimit" },
    { predicate: "paired", countName: "paired" },
    { predicate: "priceMatches", countName: "priceMatches" },
    { predicate: "resultSuccess", countName: "resultSuccess" },
    { predicate: "sourceUrlMatches", countName: "sourceUrlMatches" },
    { predicate: "symbolMatches", countName: "symbolMatches" },
  ] as const)(
    "projects a zero $countName count when only $predicate is false",
    async ({ predicate, countName }) => {
      const evidence = reduceOpenClawToolEvidence(
        stockSessionJsonLines(),
        stockTrajectory(),
        STOCK_REPLY,
      );
      const candidate = structuredClone(evidence) as OpenClawToolEvidence;
      candidate.webFetchResults[0]![predicate] = false;

      await expectAggregateStockFailure(candidate, countName);
    },
  );

  it("projects a zero public-target count for a non-public result target", async () => {
    const evidence = reduceOpenClawToolEvidence(
      stockSessionJsonLines(),
      stockTrajectory(),
      STOCK_REPLY,
    );
    const candidate = structuredClone(evidence);
    candidate.webFetchResults[0]!.target = { hostname: "127.0.0.1", protocol: "https:" };

    await expectAggregateStockFailure(candidate, "publicHttpsTarget");
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
    expect(evidence.errors).toEqual(["session line 2 is not JSON", "tool call has no bounded id"]);
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
    const projectedReply = projectNvdaPersonalStockReplyEvidence(reply);
    expect(projectedReply).toEqual({
      as_of: STOCK_REPLY.as_of,
      price: STOCK_REPLY.price,
      source: { hostname: "query1.finance.yahoo.com", protocol: "https:" },
      status: "NVDA_PERSONAL_AGENT_OK",
      symbol: "NVDA",
    });
    expect(JSON.stringify(projectedReply)).not.toContain("credential");
    expect(JSON.stringify(projectedReply)).not.toContain("/v8/finance/chart");
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
