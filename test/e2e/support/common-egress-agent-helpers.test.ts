// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  agentReplyContainsToken,
  assessPersonalPublicFetchToolEvidence,
  buildOpenClawToolEvidenceReducerScript,
  classifyHermesAgentAssertion,
  classifyOpenClawAgentAssertion,
  classifyPreContractProviderValidationSkip,
  isHermesTransientAgentFailure,
  parseChatContent,
  parseOpenClawAgentText,
  parseOpenClawToolEvidence,
  projectOpenClawAgentFailureArtifact,
  projectPersonalPublicFetchToolEvidenceArtifact,
  reduceOpenClawToolEvidence,
  runHermesAgentAssertionRetry,
  runOpenClawAgentAssertionRetry,
  type OpenClawAgentAttemptEvidenceOptions,
  type OpenClawPublicFetchExpectation,
  type OpenClawToolEvidence,
  type PersonalPublicFetchToolEvidenceArtifact,
  validateOpenClawAgentAttemptEvidence,
} from "../live/common-egress-agent-helpers.ts";

const PUBLIC_FETCH_URL =
  "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q30&props=labels&languages=en&format=json&test=must-not-remain";
const PUBLIC_FETCH_EXPECTATION = {
  content: "United States",
  url: PUBLIC_FETCH_URL,
} satisfies OpenClawPublicFetchExpectation;
const REDUCER_SECRET_SENTINEL = "nvidia-api-key-must-not-remain";

function publicFetchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: PUBLIC_FETCH_URL,
    finalUrl: PUBLIC_FETCH_URL,
    status: 200,
    contentType: "application/json",
    extractor: "json",
    externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
    fetchedAt: "2026-08-17T16:00:00Z",
    text: '{"entities":{"Q30":{"labels":{"en":{"value":"United States"}}}}}',
    ...overrides,
  };
}

function publicFetchSessionJsonLines(
  options: {
    callId?: string;
    details?: Record<string, unknown>;
    extraToolArguments?: Record<string, unknown>;
    extraToolName?: string;
    isError?: boolean;
    maxChars?: number | null;
    payload?: Record<string, unknown>;
    resultCallId?: string;
    resultToolName?: string;
  } = {},
): string {
  const callId = options.callId ?? "call-web-fetch-1";
  const payload = options.payload ?? publicFetchPayload();
  const maxChars = options.maxChars === undefined ? 8_000 : options.maxChars;
  const content = [
    {
      type: "toolCall",
      id: callId,
      name: "web_fetch",
      arguments: { url: PUBLIC_FETCH_URL, ...(maxChars === null ? {} : { maxChars }) },
    },
    ...(options.extraToolName
      ? [
          {
            type: "toolCall",
            id: "call-extra-1",
            name: options.extraToolName,
            arguments: options.extraToolArguments ?? {},
          },
        ]
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

function publicFetchTrajectory(extraToolName?: string): string {
  return JSON.stringify({
    type: "trace.artifacts",
    data: {
      finalStatus: "success",
      toolMetas: [
        { toolName: "web_fetch", meta: PUBLIC_FETCH_URL },
        ...(extraToolName ? [{ toolName: extraToolName, meta: {} }] : []),
      ],
    },
  });
}

function directPublicFetchTrajectoryWithProjection(): string {
  const messagesSnapshot = publicFetchSessionJsonLines()
    .split("\n")
    .map((line) => (JSON.parse(line) as { message: unknown }).message);
  return [
    JSON.stringify({ type: "model.completed", data: { messagesSnapshot } }),
    publicFetchTrajectory(),
  ].join("\n");
}

function progressivePublicFetchSessionJsonLines(
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
        args: { url: PUBLIC_FETCH_URL, ...(maxChars === null ? {} : { maxChars }) },
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

function progressivePublicFetchTrajectory(
  options: {
    maxChars?: number | null;
    payload?: Record<string, unknown>;
    projectedParentCallId?: string;
    projectedTargetName?: string;
    wrapperTargetId?: string;
  } = {},
): string {
  const payload = options.payload ?? publicFetchPayload();
  const projectedTargetName = options.projectedTargetName ?? "web_fetch";
  const maxChars = options.maxChars === undefined ? 8_000 : options.maxChars;
  const targetArguments = {
    url: PUBLIC_FETCH_URL,
    ...(maxChars === null ? {} : { maxChars }),
  };
  const sessionMessages = progressivePublicFetchSessionJsonLines(options)
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
          { toolName: projectedTargetName, meta: PUBLIC_FETCH_URL },
          { toolName: "tool_call", meta: {} },
        ],
      },
    }),
  ].join("\n");
}

function publicFetchAttemptValidationOptions(
  overrides: Partial<OpenClawAgentAttemptEvidenceOptions> = {},
): OpenClawAgentAttemptEvidenceOptions {
  const evidence = reduceOpenClawToolEvidence(
    publicFetchSessionJsonLines(),
    publicFetchTrajectory(),
    PUBLIC_FETCH_EXPECTATION,
  );
  return {
    classification: { passed: true },
    label: "personal-public-fetch",
    recordToolEvidenceReductionFailure: vi.fn().mockResolvedValue(undefined),
    recordToolEvidence: vi.fn().mockResolvedValue(undefined),
    reduceToolEvidence: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: `__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
    }),
    reply: "PERSONAL_PUBLIC_FETCH_OK",
    toolEvidenceValidator: (candidate) => assessPersonalPublicFetchToolEvidence(candidate).matches,
    ...overrides,
  };
}

async function expectAggregatePublicFetchFailure(
  evidence: OpenClawToolEvidence,
  countName: keyof PersonalPublicFetchToolEvidenceArtifact["webFetchResultCounts"],
): Promise<void> {
  const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
  const result = await validateOpenClawAgentAttemptEvidence(
    publicFetchAttemptValidationOptions({
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
    PUBLIC_FETCH_URL,
    PUBLIC_FETCH_EXPECTATION.content,
    publicFetchPayload().text as string,
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
        JSON.stringify([
          { payloads: [{ text: "FIRST_AGENT_REPLY" }] },
          { result: { payloads: [{ text: "SECOND_AGENT_REPLY" }] } },
        ]),
      ),
    ).toBe("FIRST_AGENT_REPLY\nSECOND_AGENT_REPLY");
    expect(
      parseOpenClawAgentText(
        `openclaw log line\n${JSON.stringify({
          result: { payloads: [{ text: "HERMES_REFERENCE_AGENT_OK" }] },
        })}\n`,
      ),
    ).toContain("HERMES_REFERENCE_AGENT_OK");
  });

  it("reduces OpenClaw public-fetch traces without retaining fetched content or URL queries", () => {
    const source = "www.wikidata.org";
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines(),
      publicFetchTrajectory(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(evidence).toEqual({
      schemaVersion: 1,
      controlTargetViolations: 0,
      errors: [],
      finalStatuses: ["success"],
      projectedTargetEvidence: false,
      providerMentions: [],
      toolCalls: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolExecutions: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      toolResults: [{ name: "web_fetch", target: { hostname: source, protocol: "https:" } }],
      unexpectedWebFetchCalls: 0,
      unexpectedWebFetchExecutions: 0,
      unexpectedWebFetchResults: 0,
      webFetchResults: [
        {
          expectedContentMatches: true,
          expectedUrlMatches: true,
          httpSuccess: true,
          maxCharsWithinLimit: true,
          paired: true,
          resultSuccess: true,
          target: { hostname: source, protocol: "https:" },
        },
      ],
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-remain");
    expect(JSON.stringify(evidence)).not.toContain("United States");
    expect(JSON.stringify(evidence)).not.toContain("/w/api.php");
    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
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
  });

  it("executes the generated reducer script against OpenClaw JSONL artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-openclaw-reducer-"));
    try {
      const sessionPath = join(directory, "session.jsonl");
      const trajectoryPath = join(directory, "trajectory.jsonl");
      writeFileSync(sessionPath, `${publicFetchSessionJsonLines()}\n`);
      writeFileSync(trajectoryPath, `${publicFetchTrajectory()}\n`);

      const result = spawnSync(
        process.execPath,
        [
          "-e",
          buildOpenClawToolEvidenceReducerScript(PUBLIC_FETCH_EXPECTATION),
          sessionPath,
          trajectoryPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(parseOpenClawToolEvidence(result.stdout)).toMatchObject({
        errors: [],
        finalStatuses: ["success"],
        toolCalls: [{ name: "web_fetch", target: { hostname: "www.wikidata.org" } }],
        toolExecutions: [{ name: "web_fetch", target: { hostname: "www.wikidata.org" } }],
        toolResults: [{ name: "web_fetch", target: { hostname: "www.wikidata.org" } }],
        webFetchResults: [
          expect.objectContaining({
            expectedContentMatches: true,
            expectedUrlMatches: true,
            paired: true,
            resultSuccess: true,
          }),
        ],
      });
      expect(result.stdout).not.toContain("must-not-remain");
      expect(result.stdout).not.toContain("United States");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("uses a direct-call model snapshot for complete results without granting control tools", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        details: { persistedDetailsTruncated: true },
        payload: publicFetchPayload({ text: "persisted result was truncated" }),
      }),
      directPublicFetchTrajectoryWithProjection(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      forbiddenToolNames: [],
      matches: true,
      projectedTargetEvidence: false,
      qualifyingWebFetchResults: 1,
    });
  });

  it("rejects projected evidence that hides a forbidden session tool and search provider", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        extraToolArguments: { provider: "brave", query: "public reference" },
        extraToolName: "web_search",
      }),
      directPublicFetchTrajectoryWithProjection(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: ["brave"],
      forbiddenToolNames: ["web_search"],
      matches: false,
    });
  });

  it("rejects projected evidence that hides a different public fetch target", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        extraToolArguments: { maxChars: 8_000, url: "https://example.com/" },
        extraToolName: "web_fetch",
      }),
      directPublicFetchTrajectoryWithProjection(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 1,
      unexpectedWebFetchCalls: 1,
    });
  });

  it("rejects a public fetch redirected away from the fixed target", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        payload: publicFetchPayload({ finalUrl: "https://example.com/redirected" }),
      }),
      publicFetchTrajectory(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(evidence.webFetchResults).toContainEqual(
      expect.objectContaining({ expectedContentMatches: true, expectedUrlMatches: false }),
    );
    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 0,
      unexpectedWebFetchResults: 1,
    });
  });

  it("rejects a different public fetch target recorded only as a tool execution", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines(),
      [
        directPublicFetchTrajectoryWithProjection(),
        JSON.stringify({
          type: "trace.artifacts",
          data: {
            toolMetas: [{ toolName: "web_fetch", meta: "https://example.com/" }],
          },
        }),
      ].join("\n"),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 1,
      unexpectedWebFetchExecutions: 1,
    });
  });

  it("accepts a progressive Tool Search wrapper only with projected web_fetch proof", () => {
    const evidence = reduceOpenClawToolEvidence(
      progressivePublicFetchSessionJsonLines(),
      progressivePublicFetchTrajectory(),
      PUBLIC_FETCH_EXPECTATION,
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
    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: [],
      forbiddenToolNames: [],
      matches: true,
      qualifyingWebFetchResults: 1,
      webFetchCalls: 1,
      webFetchExecutions: 1,
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-remain");
    expect(JSON.stringify(evidence)).not.toContain("United States");
  });

  it("rejects progressive controls without a projected target call and result", () => {
    const trajectory = progressivePublicFetchTrajectory()
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
      progressivePublicFetchSessionJsonLines(),
      trajectory,
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 0,
      webFetchCalls: 0,
    });
  });

  it("rejects fallback controls that target exec beside an otherwise valid direct fetch", () => {
    const evidence = reduceOpenClawToolEvidence(
      [
        publicFetchSessionJsonLines(),
        progressivePublicFetchSessionJsonLines({ wrapperTargetId: "openclaw:core:exec" }),
      ].join("\n"),
      publicFetchTrajectory("tool_call"),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
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
      session: publicFetchSessionJsonLines({ maxChars: 8_001 }),
      trajectory: publicFetchTrajectory(),
    },
    {
      name: "an oversized progressive fetch",
      session: progressivePublicFetchSessionJsonLines({ maxChars: 8_001 }),
      trajectory: progressivePublicFetchTrajectory({ maxChars: 8_001 }),
    },
    {
      name: "a direct fetch that omits maxChars",
      session: publicFetchSessionJsonLines({ maxChars: null }),
      trajectory: publicFetchTrajectory(),
    },
  ])("rejects $name", ({ session, trajectory }) => {
    const evidence = reduceOpenClawToolEvidence(session, trajectory, PUBLIC_FETCH_EXPECTATION);

    expect(evidence.webFetchResults).toContainEqual(
      expect.objectContaining({ maxCharsWithinLimit: false }),
    );
    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: false,
      qualifyingWebFetchResults: 0,
    });
  });

  it.each([
    {
      name: "a forbidden projected target",
      projectedTargetName: "exec",
      payload: publicFetchPayload(),
    },
    {
      name: "a Brave Search-backed projected fetch",
      projectedTargetName: "web_fetch",
      payload: publicFetchPayload({
        externalContent: {
          untrusted: true,
          source: "web_fetch",
          provider: "brave",
          wrapped: true,
        },
      }),
    },
  ])("rejects $name behind progressive controls", ({ payload, projectedTargetName }) => {
    const evidence = reduceOpenClawToolEvidence(
      progressivePublicFetchSessionJsonLines(),
      progressivePublicFetchTrajectory({ payload, projectedTargetName }),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence).matches).toBe(false);
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
        progressivePublicFetchSessionJsonLines({ wrapperTargetId }),
        progressivePublicFetchTrajectory({ projectedParentCallId, wrapperTargetId }),
        PUBLIC_FETCH_EXPECTATION,
      );

      expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
        controlTargetViolations,
        matches: false,
        projectedTargetEvidence: false,
      });
    },
  );

  it("projects public-fetch evidence without fetched content or URL queries and keeps diagnostics aggregate-only", async () => {
    const providerSentinel = "brave";
    const toolSentinel = "tool-secret-sentinel";
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        extraToolName: toolSentinel,
        payload: publicFetchPayload({
          externalContent: {
            untrusted: true,
            source: "web_fetch",
            provider: providerSentinel,
            wrapped: true,
          },
        }),
      }),
      publicFetchTrajectory(toolSentinel),
      PUBLIC_FETCH_EXPECTATION,
    );
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    const serialized = JSON.stringify(artifact);

    expect(artifact).toMatchObject({
      errorCount: 0,
      finalSuccess: true,
      forbiddenProviderMentionCount: 1,
      forbiddenToolCount: 1,
      matches: false,
      publicHttpsTargets: [{ hostname: "www.wikidata.org", protocol: "https:" }],
      unexpectedWebFetchCalls: 0,
      unexpectedWebFetchExecutions: 0,
      unexpectedWebFetchResults: 0,
      webFetchResultCounts: {
        expectedContentMatches: 1,
        expectedUrlMatches: 1,
        httpSuccess: 1,
        maxCharsWithinLimit: 1,
        paired: 1,
        publicHttpsTarget: 1,
        resultSuccess: 1,
        total: 1,
      },
    });
    expect(serialized).not.toContain(providerSentinel);
    expect(serialized).not.toContain(toolSentinel);
    expect(serialized).not.toContain("must-not-remain");
    expect(serialized).not.toContain("United States");

    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions({
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
    { predicate: "expectedContentMatches", countName: "expectedContentMatches" },
    { predicate: "expectedUrlMatches", countName: "expectedUrlMatches" },
    { predicate: "httpSuccess", countName: "httpSuccess" },
    { predicate: "maxCharsWithinLimit", countName: "maxCharsWithinLimit" },
    { predicate: "paired", countName: "paired" },
    { predicate: "resultSuccess", countName: "resultSuccess" },
  ] as const)(
    "projects a zero $countName count when only $predicate is false",
    async ({ predicate, countName }) => {
      const evidence = reduceOpenClawToolEvidence(
        publicFetchSessionJsonLines(),
        publicFetchTrajectory(),
        PUBLIC_FETCH_EXPECTATION,
      );
      const candidate = structuredClone(evidence) as OpenClawToolEvidence;
      candidate.webFetchResults[0]![predicate] = false;

      await expectAggregatePublicFetchFailure(candidate, countName);
    },
  );

  it("projects a zero public-target count for a non-public result target", async () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines(),
      publicFetchTrajectory(),
      PUBLIC_FETCH_EXPECTATION,
    );
    const candidate = structuredClone(evidence);
    candidate.webFetchResults[0]!.target = { hostname: "127.0.0.1", protocol: "https:" };

    await expectAggregatePublicFetchFailure(candidate, "publicHttpsTarget");
  });

  it("validates and records a successful Personal public-fetch attempt", async () => {
    const recordToolEvidence = vi.fn().mockResolvedValue(undefined);
    const reduceToolEvidence = vi
      .fn()
      .mockImplementation(publicFetchAttemptValidationOptions().reduceToolEvidence);
    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions({ recordToolEvidence, reduceToolEvidence }),
    );

    expect(result).toMatchObject({
      attempt: { passed: true },
      evidence: {
        reply: "PERSONAL_PUBLIC_FETCH_OK",
        toolEvidence: { errors: [], finalStatuses: ["success"] },
      },
    });
    expect(reduceToolEvidence).toHaveBeenCalledWith();
    expect(recordToolEvidence).toHaveBeenCalledWith(result.evidence?.toolEvidence);
  });

  it("rejects conflicting successful and failed terminal statuses", async () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines(),
      [
        publicFetchTrajectory(),
        JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "failed" } }),
      ].join("\n"),
      PUBLIC_FETCH_EXPECTATION,
    );
    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions({
        reduceToolEvidence: vi.fn().mockResolvedValue({
          exitCode: 0,
          stdout: `__NEMOCLAW_TOOL_EVIDENCE__=${JSON.stringify(evidence)}\n`,
        }),
      }),
    );

    expect(evidence.finalStatuses).toEqual(["failed", "success"]);
    expect(projectPersonalPublicFetchToolEvidenceArtifact(evidence)).toMatchObject({
      finalStatusCount: 2,
      finalSuccess: false,
      matches: false,
    });
    expect(result).toMatchObject({
      attempt: { passed: false, failureClass: "deterministic" },
      failure: expect.stringContaining("finalSuccess=false"),
    });
  });

  it("preserves a failed OpenClaw classification before evidence collection", async () => {
    const reduceToolEvidence = vi.fn();
    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions({
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

  it("projects a bounded agent-command failure before reducer execution", () => {
    const artifact = projectOpenClawAgentFailureArtifact(
      2,
      { passed: false, failureClass: "authentication" },
      {
        exitCode: 1,
        signal: null,
        stderr: `credential=${REDUCER_SECRET_SENTINEL}`,
        stdout: `${PUBLIC_FETCH_URL} ${PUBLIC_FETCH_EXPECTATION.content}`,
        timedOut: false,
      },
    );

    expect(artifact).toEqual({
      schemaVersion: 1,
      attempt: 2,
      diagnosticSummary: "command-exited-nonzero",
      exitCode: 1,
      failureClass: "authentication",
      signal: null,
      timedOut: false,
    });
    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(PUBLIC_FETCH_URL);
    expect(serialized).not.toContain(PUBLIC_FETCH_EXPECTATION.content);
    expect(serialized).not.toContain(REDUCER_SECRET_SENTINEL);
  });

  it.each([
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
  ])("rejects $name deterministically", async ({ overrides, failure }) => {
    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions(overrides),
    );

    expect(result.attempt).toEqual({ passed: false, failureClass: "deterministic" });
    expect(result.failure).toMatch(failure);
    expect(result.evidence).toBeUndefined();
  });

  it.each([
    {
      name: "a reducer command failure",
      reduced: {
        exitCode: 2,
        signal: "SIGTERM" as const,
        stderr: `credential=${REDUCER_SECRET_SENTINEL}`,
        stdout: `${PUBLIC_FETCH_URL} ${PUBLIC_FETCH_EXPECTATION.content}`,
        timedOut: true,
      },
      expected: {
        schemaVersion: 1,
        failureClass: "command-failed",
        exitCode: 2,
        signal: "SIGTERM",
        timedOut: true,
      },
    },
    {
      name: "malformed reducer output",
      reduced: {
        exitCode: 0,
        signal: null,
        stderr: `credential=${REDUCER_SECRET_SENTINEL}`,
        stdout: `${PUBLIC_FETCH_URL} ${PUBLIC_FETCH_EXPECTATION.content}`,
        timedOut: false,
      },
      expected: {
        schemaVersion: 1,
        failureClass: "output-invalid",
        exitCode: 0,
        signal: null,
        timedOut: false,
      },
    },
  ])("records bounded diagnostics for $name", async ({ reduced, expected }) => {
    const recordToolEvidenceReductionFailure = vi.fn().mockResolvedValue(undefined);
    const result = await validateOpenClawAgentAttemptEvidence(
      publicFetchAttemptValidationOptions({
        recordToolEvidenceReductionFailure,
        reduceToolEvidence: vi.fn().mockResolvedValue(reduced),
      }),
    );

    expect(result.attempt).toEqual({ passed: false, failureClass: "deterministic" });
    expect(recordToolEvidenceReductionFailure).toHaveBeenCalledOnce();
    expect(recordToolEvidenceReductionFailure).toHaveBeenCalledWith(expected);
    const serialized = JSON.stringify(recordToolEvidenceReductionFailure.mock.calls);
    expect(serialized).not.toContain(PUBLIC_FETCH_URL);
    expect(serialized).not.toContain(PUBLIC_FETCH_EXPECTATION.content);
    expect(serialized).not.toContain(REDUCER_SECRET_SENTINEL);
  });

  it("uses parseable tool-result text when persisted OpenClaw details are capped", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({ details: { persistedDetailsTruncated: true } }),
      publicFetchTrajectory(),
      PUBLIC_FETCH_EXPECTATION,
    );

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      matches: true,
      qualifyingWebFetchResults: 1,
    });
  });

  it("rejects Brave Search or Tavily Search and non-public fetch trajectories", () => {
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
                arguments: { provider: "brave", query: "public reference" },
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

    expect(assessPersonalPublicFetchToolEvidence(evidence)).toMatchObject({
      forbiddenProviderMentions: ["brave", "tavily"],
      forbiddenToolNames: ["web_search"],
      matches: false,
      publicHttpsTargets: [],
    });
    expect(evidence.errors).toEqual(["session line 2 is not JSON", "tool call has no bounded id"]);
  });

  it.each([
    {
      name: "a failed tool result",
      session: publicFetchSessionJsonLines({ isError: true }),
      trajectory: publicFetchTrajectory(),
    },
    {
      name: "content without the fixed reference label",
      session: publicFetchSessionJsonLines({
        payload: publicFetchPayload({ text: '{"entities":{"Q30":{"labels":{}}}}' }),
      }),
      trajectory: publicFetchTrajectory(),
    },
    {
      name: "a Brave Search provider result",
      session: publicFetchSessionJsonLines({
        payload: publicFetchPayload({
          externalContent: {
            untrusted: true,
            source: "web_fetch",
            provider: "brave",
            wrapped: true,
          },
        }),
      }),
      trajectory: publicFetchTrajectory(),
    },
    {
      name: "mismatched tool call id",
      session: publicFetchSessionJsonLines({ resultCallId: "call-web-fetch-other" }),
      trajectory: publicFetchTrajectory(),
    },
    {
      name: "a fetch plus another target tool",
      session: publicFetchSessionJsonLines({ extraToolName: "exec" }),
      trajectory: publicFetchTrajectory("exec"),
    },
    {
      name: "a result from a different URL",
      session: publicFetchSessionJsonLines({
        payload: publicFetchPayload({ url: "https://www.wikidata.org/wiki/Q30" }),
      }),
      trajectory: publicFetchTrajectory(),
    },
  ])("rejects $name", ({ session, trajectory }) => {
    const evidence = reduceOpenClawToolEvidence(session, trajectory, PUBLIC_FETCH_EXPECTATION);

    expect(assessPersonalPublicFetchToolEvidence(evidence).matches).toBe(false);
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
