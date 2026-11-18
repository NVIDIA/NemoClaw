// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  reduceOpenClawToolEvidence,
  projectPersonalPublicFetchToolEvidenceArtifact,
} from "../live/common-egress-agent-helpers.ts";

const PUBLIC_FETCH_URL = "https://www.wikidata.org/w/api.php?test=must-not-remain";
const PUBLIC_FETCH_EXPECTATION = { content: "United States", url: PUBLIC_FETCH_URL };
const REDUCER_SECRET_SENTINEL = "nvidia-api-key-must-not-remain";
function publicFetchPayload(overrides: Record<string, unknown> = {}) {
  return {
    url: PUBLIC_FETCH_URL,
    finalUrl: PUBLIC_FETCH_URL,
    status: 200,
    text: "United States",
    ...overrides,
  };
}
function publicFetchSessionJsonLines(options: {
  payload: Record<string, unknown>;
  isError?: boolean;
}) {
  return [
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "fetch-1",
            name: "web_fetch",
            arguments: { url: PUBLIC_FETCH_URL, maxChars: 8000 },
          },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "fetch-1",
        toolName: "web_fetch",
        isError: options.isError ?? false,
        details: options.payload,
        content: [{ type: "text", text: JSON.stringify(options.payload) }],
      },
    },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n");
}

describe("public-fetch failure diagnostics", () => {
  it("records HTTP status from tool results without trusting the assistant's explanation", () => {
    const session = publicFetchSessionJsonLines({
      isError: true,
      payload: publicFetchPayload({ status: 503, text: REDUCER_SECRET_SENTINEL }),
    });
    const evidence = reduceOpenClawToolEvidence(session, "", PUBLIC_FETCH_EXPECTATION);
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toEqual([
      { httpStatus: 503, toolError: true, paired: true, errorCategory: "http" },
    ]);
    expect(artifact.matches).toBe(false);
    expect(JSON.stringify(artifact)).not.toContain(REDUCER_SECRET_SENTINEL);
    const assistantOnly = reduceOpenClawToolEvidence(
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Wikimedia returned HTTP 503" }],
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(assistantOnly).webFetchDiagnostics,
    ).toEqual([]);
  });

  it("reads the pinned producer's error prefix without retaining its response detail", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        payload: {
          status: "error",
          tool: "web_fetch",
          error: `Web fetch failed (503): ${REDUCER_SECRET_SENTINEL}`,
        },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toEqual([
      { httpStatus: 503, toolError: true, paired: true, errorCategory: "http" },
    ]);
    expect(artifact.matches).toBe(false);
    expect(evidence.webFetchResults[0]?.httpSuccess).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(REDUCER_SECRET_SENTINEL);
  });

  it.each([
    { status: "error", tool: "web_fetch", error: "Agent said Web fetch failed (503): details" },
    { status: "error", tool: "web_fetch", error: "Web fetch failed (999): details" },
    { status: "error", tool: "web_fetch", error: "Web fetch failed (5030): details" },
    { status: "error", tool: "other", error: "Web fetch failed (503): details" },
    { status: "ok", tool: "web_fetch", error: "Web fetch failed (503): details" },
  ])("does not infer HTTP status from unsupported error shapes: %j", (payload) => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({ payload }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics[0]?.httpStatus,
    ).toBeNull();
  });

  it("keeps missing tool HTTP status unknown and bounds diagnostic records", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        isError: true,
        payload: { status: "error", error: "private details" },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics).toEqual([
      { httpStatus: null, toolError: true, paired: true, errorCategory: "unknown" },
    ]);
    evidence.webFetchResults = Array.from({ length: 100 }, () => ({
      ...evidence.webFetchResults[0]!,
      httpStatus: 999,
    }));
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toHaveLength(64);
    expect(artifact.webFetchDiagnostics.every((record) => record.httpStatus === null)).toBe(true);
    expect(JSON.stringify(artifact)).not.toContain("private details");
  });
  it.each([
    ["Invalid URL: must be http or https", "invalid-url"],
    ["maxChars must be a positive integer", "invalid-max-chars"],
    ["web_fetch is disabled.", "disabled"],
    ["fetch failed", "fetch-failed"],
    [
      "Web fetch extraction failed: Readability disabled and no fetch provider is available.",
      "extraction",
    ],
    [`Web fetch extraction failed: ${REDUCER_SECRET_SENTINEL}`, "extraction"],
    [`unknown failure: ${REDUCER_SECRET_SENTINEL}`, "other"],
    [`Invalid URL: must be http or https ${REDUCER_SECRET_SENTINEL}`, "other"],
  ])("retains only the category for a tool error: %s", (error, category) => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        payload: { status: "error", tool: "web_fetch", error },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics).toEqual([
      { httpStatus: null, toolError: true, paired: true, errorCategory: category },
    ]);
    expect(artifact.matches).toBe(false);
    expect(evidence.webFetchResults[0]?.resultSuccess).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(REDUCER_SECRET_SENTINEL);
    expect(JSON.stringify(artifact)).not.toContain(REDUCER_SECRET_SENTINEL);
  });

  it.each([
    { status: "error", tool: "other", error: "fetch failed" },
    { status: "ok", tool: "web_fetch", error: "fetch failed" },
    { status: "error", tool: "web_fetch", error: { message: "fetch failed" } },
    { status: "error", error: "fetch failed" },
  ])("keeps unsupported error envelopes unknown: %j", (payload) => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({ payload, isError: true }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics[0]
        ?.errorCategory,
    ).toBe("unknown");
  });

  it("does not classify a successful result as an error", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({ payload: publicFetchPayload({ error: "fetch failed" }) }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    expect(
      projectPersonalPublicFetchToolEvidenceArtifact(evidence).webFetchDiagnostics[0]
        ?.errorCategory,
    ).toBeNull();
    expect(evidence.webFetchResults[0]?.resultSuccess).toBe(true);
  });

  it("discards unrecognized categories at the host artifact boundary", () => {
    const evidence = reduceOpenClawToolEvidence(
      publicFetchSessionJsonLines({
        payload: { status: "error", tool: "web_fetch", error: "fetch failed" },
      }),
      "",
      PUBLIC_FETCH_EXPECTATION,
    );
    Object.assign(evidence.webFetchResults[0]!, { errorCategory: REDUCER_SECRET_SENTINEL });
    const artifact = projectPersonalPublicFetchToolEvidenceArtifact(evidence);
    expect(artifact.webFetchDiagnostics[0]?.errorCategory).toBe("unknown");
    expect(JSON.stringify(artifact)).not.toContain(REDUCER_SECRET_SENTINEL);
  });
});
