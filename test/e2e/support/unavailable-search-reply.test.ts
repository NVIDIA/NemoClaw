// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyOpenClawAgentAssertion,
  isUnavailableSearchReply,
  hasUnavailableSearchToolEvidence,
  reduceOpenClawToolEvidence,
  projectUnavailableSearchReplyArtifact,
} from "../live/common-egress-agent-helpers.ts";

describe("unavailable web-search reply evidence", () => {
  it("rejects a fabricated documentation result even when the expected reply key is present", () => {
    const reply = JSON.stringify({
      searchStatus: "unavailable",
      installationDocumentation: {
        title: "NVIDIA Announces NemoClaw",
        url: "https://nvidianews.nvidia.com/",
      },
    });
    expect(
      classifyOpenClawAgentAssertion({
        exitCode: 0,
        expected: "searchStatus",
        reply,
        response: reply,
      }),
    ).toEqual({ passed: true });
    expect(isUnavailableSearchReply(reply)).toBe(false);
    expect(isUnavailableSearchReply(`Web search is unavailable.\n${reply}`)).toBe(false);
  });

  it.each([
    'Based on my investigation of the local files, there is no separate "official NVIDIA NemoClaw installation documentation" page.',
    "Based on my research of the OpenClaw documentation: Page Title: NVIDIA announces NemoClaw. URL: https://nvidianews.nvidia.com/",
    JSON.stringify({ searchStatus: "available", installationDocumentation: null }),
  ])("rejects an unsupported or incomplete reply: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(false);
  });

  it.each([
    '{"searchStatus":"unavailable","installationDocumentation":null}\nOfficial installation documentation: NVIDIA Announces NemoClaw, https://nvidianews.nvidia.com/',
    '```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```\nOfficial installation documentation: NVIDIA Announces NemoClaw, https://nvidianews.nvidia.com/',
    'Official installation documentation: NVIDIA Announces NemoClaw.\n{"searchStatus":"unavailable","installationDocumentation":null}',
    '{"searchStatus":"unavailable","installationDocumentation":null}\n{"installationDocumentation":{"url":"https://nvidianews.nvidia.com/"}}',
    '{"searchStatus":"unavailable","installationDocumentation":null,"claim":"NVIDIA Announces NemoClaw is the official installation documentation"}',
    'I searched the web.\n{"searchStatus":"unavailable","installationDocumentation":null}',
    'I have searched Tavily.\n{"searchStatus":"unavailable","installationDocumentation":null}',
  ])("rejects claims outside the unavailable-search fields: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(false);
  });

  it.each([
    '{"searchStatus":"unavailable","installationDocumentation":null}',
    '  \n{"searchStatus":"unavailable","installationDocumentation":null}\n  ',
  ])("accepts a complete unavailable-search JSON reply: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(true);
  });

  it.each([
    'Web search is unavailable in this sandbox.\n{"searchStatus":"unavailable","installationDocumentation":null}',
    '{"searchStatus":"unavailable","installationDocumentation":null}\nPlease configure a search provider.',
    'Web search is unavailable.\n```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```',
  ])("accepts surrounding prose with a parsed null documentation result: %s", (reply) => {
    expect(isUnavailableSearchReply(reply)).toBe(true);
  });

  it("accepts an unavailable-search reply with no claimed installation documentation", () =>
    expect(
      isUnavailableSearchReply(
        '```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```',
      ),
    ).toBe(true));
});

describe("unavailable-search reply diagnostics", () => {
  it.each([
    [
      "not JSON",
      {
        jsonParseStatus: "invalid",
        surroundingProse: "unknown",
        fields: [],
        searchStatus: "missing",
        installationDocumentationType: "missing",
      },
    ],
    [
      '{"searchStatus":"available","installationDocumentation":null}',
      {
        jsonParseStatus: "valid",
        surroundingProse: "absent",
        fields: ["searchStatus", "installationDocumentation"],
        searchStatus: "available",
        installationDocumentationType: "null",
      },
    ],
    [
      '{"searchStatus":"unknown"}',
      {
        jsonParseStatus: "valid",
        searchStatus: "unknown",
        installationDocumentationType: "missing",
      },
    ],
    [
      '{"searchStatus":"private-query","installationDocumentation":{"url":"https://private.test/?token=secret"}}',
      { searchStatus: "other", installationDocumentationType: "object" },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":[]} ',
      { searchStatus: "unavailable", installationDocumentationType: "array" },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":"private-content"}',
      { installationDocumentationType: "string" },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":false}',
      { installationDocumentationType: "boolean" },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":42}',
      { installationDocumentationType: "number" },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":null}\nprivate prose',
      {
        jsonParseStatus: "invalid",
        surroundingProse: "present",
        searchStatus: "unavailable",
        installationDocumentationType: "null",
      },
    ],
    [
      '{"searchStatus":"unavailable","installationDocumentation":null,"https://private.test/?secret":true}',
      { fields: ["searchStatus", "installationDocumentation"], unexpectedFieldCount: 1 },
    ],
    ["null", { jsonParseStatus: "valid", fields: [], searchStatus: "missing" }],
    ["[]", { jsonParseStatus: "valid", fields: [], searchStatus: "missing" }],
  ])("classifies a rejected reply without retaining its contents: %s", (reply, diagnostic) => {
    const artifact = projectUnavailableSearchReplyArtifact(reply);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      unavailableSearchReply: false,
      ...diagnostic,
    });
    expect(JSON.stringify(artifact)).not.toMatch(/private|secret|https:|token=/u);
  });

  it("bounds diagnostics when a reply contains many arbitrary fields", () => {
    const reply = JSON.stringify(
      Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`private-${i}`, "secret"])),
    );
    const artifact = projectUnavailableSearchReplyArtifact(reply);
    expect(artifact).toMatchObject({
      fields: [],
      unexpectedFieldCount: 1000,
      unavailableSearchReply: false,
    });
    expect(JSON.stringify(artifact).length).toBeLessThan(400);
  });

  it("reports a fully fenced unavailable-search answer as valid", () => {
    expect(
      projectUnavailableSearchReplyArtifact(
        '```json\n{"searchStatus":"unavailable","installationDocumentation":null}\n```',
      ),
    ).toEqual({
      schemaVersion: 1,
      unavailableSearchReply: true,
      jsonParseStatus: "valid",
      fields: ["searchStatus", "installationDocumentation"],
      unexpectedFieldCount: 0,
      searchStatus: "unavailable",
      installationDocumentationType: "null",
      surroundingProse: "absent",
    });
  });
});

describe("unavailable-search tool evidence", () => {
  it.each([
    "tool_search",
    "tool_describe",
    "tool_call",
    "search",
    "read",
    "exec",
    "memory_search",
    "web_fetch",
    "unrecognized_tool",
  ])("rejects a %s tool call", (name) => {
    const evidence = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "discovery", name, arguments: {} }],
        },
      }),
      JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
    );
    expect(evidence.toolCalls).toContainEqual({ name });
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
  });

  it.each([
    "tool_search",
    "tool_describe",
    "tool_call",
    "search",
    "read",
    "exec",
    "memory_search",
    "web_fetch",
    "unrecognized_tool",
  ])("rejects a %s tool execution", (name) => {
    const evidence = reduceOpenClawToolEvidence(
      "",
      JSON.stringify({
        type: "trace.artifacts",
        data: { finalStatus: "success", toolMetas: [{ name }] },
      }),
    );
    expect(evidence.toolExecutions).toContainEqual({ name });
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
  });

  it.each([
    "tool_search",
    "tool_describe",
    "tool_call",
    "search",
    "read",
    "exec",
    "memory_search",
    "web_fetch",
    "unrecognized_tool",
  ])("rejects an orphaned %s tool result", (name) => {
    const evidence = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: { role: "toolResult", toolName: name, toolCallId: "orphan", content: [] },
      }),
      JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
    );
    expect(evidence.toolResults).toContainEqual({ name });
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
  });

  it.each(["brave", "tavily"])("rejects a generic call with %s provider metadata", (provider) => {
    const evidence = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "generic-call", name: "search", arguments: { provider } },
          ],
        },
      }),
      JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
    );
    expect(evidence.providerMentions).toContain(provider);
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
  });

  it.each(["brave", "tavily"])(
    "rejects a generic execution with %s provider metadata",
    (provider) => {
      const evidence = reduceOpenClawToolEvidence(
        "",
        JSON.stringify({
          type: "trace.artifacts",
          data: { finalStatus: "success", toolMetas: [{ name: "search", meta: { provider } }] },
        }),
      );
      expect(evidence.providerMentions).toContain(provider);
      expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
    },
  );

  it.each(["brave", "tavily"])("rejects a generic result with %s provider metadata", (provider) => {
    const evidence = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: {
          role: "toolResult",
          toolName: "search",
          toolCallId: "orphan",
          details: { provider },
          content: [],
        },
      }),
      JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
    );
    expect(evidence.providerMentions).toContain(provider);
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
  });

  it.each(["web_search", "brave_search", "tavily_search"])(
    "rejects an orphaned %s tool result",
    (name) => {
      const evidence = reduceOpenClawToolEvidence(
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolName: name, toolCallId: "orphan", content: [] },
        }),
        JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
      );
      expect(evidence.toolResults).toContainEqual({ name });
      expect(hasUnavailableSearchToolEvidence(evidence)).toBe(false);
    },
  );

  it("accepts a completed turn without tool activity", () => {
    const evidence = reduceOpenClawToolEvidence(
      "",
      JSON.stringify({ type: "trace.artifacts", data: { finalStatus: "success" } }),
    );
    expect(hasUnavailableSearchToolEvidence(evidence)).toBe(true);
  });
});
