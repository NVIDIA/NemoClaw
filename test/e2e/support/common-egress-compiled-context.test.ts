// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  buildOpenClawToolEvidenceReducerScript,
  isUnavailableSearchReply,
  OPENCLAW_TOOL_EVIDENCE_MARKER,
  parseOpenClawToolEvidence,
  projectUnavailableSearchToolEvidenceArtifact,
  reduceOpenClawToolEvidence,
} from "../live/common-egress-agent-helpers.ts";

const PRIVATE = "private-prompt-tool-and-run-sentinel";
const PROMPT = `<nemoclaw-runtime>
Web search is disabled in OpenClaw configuration.
For web-search requests, tell the user that web search is unavailable immediately.
${PRIVATE}
</nemoclaw-runtime>`;
const COMPLETED = {
  type: "model.completed",
  runId: "selected-run",
  data: { messagesSnapshot: [] },
};
const EXPECTED = {
  runtimeMarkerPresent: true,
  disabledSearchPresent: true,
  unavailableInstructionPresent: true,
  providerToolCount: 0,
};
function compiled(runId = "selected-run", data: Record<string, unknown> = {}) {
  return { type: "context.compiled", runId, data: { systemPrompt: PROMPT, tools: [], ...data } };
}
function jsonLines(events: unknown[]) {
  return events.map((event) => JSON.stringify(event)).join("\n");
}
function reduce(events: unknown[]) {
  return reduceOpenClawToolEvidence("", jsonLines(events));
}

describe("compiled disabled-search context diagnostics", () => {
  it("projects only fixed observations from the completed run", () => {
    const evidence = reduce([
      compiled("selected-run", { tools: [{ name: PRIVATE }], providerVisibleTools: [] }),
      COMPLETED,
    ]);
    const artifact = projectUnavailableSearchToolEvidenceArtifact(evidence);
    expect(artifact.compiledSearchContext).toEqual(EXPECTED);
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE);
    expect(JSON.stringify(artifact)).not.toContain("selected-run");
    expect(
      isUnavailableSearchReply('{"searchStatus":"available","installationDocumentation":null}'),
    ).toBe(false);
  });

  it.each([
    [],
    [COMPLETED],
    [compiled()],
    [compiled(PRIVATE), COMPLETED],
    [compiled("selected-run", { systemPrompt: null }), COMPLETED],
    [compiled(), compiled("selected-run", { systemPrompt: null }), COMPLETED],
    [
      compiled(),
      compiled("selected-run", { systemPrompt: "[Oversized diagnostic JSON redacted]" }),
      COMPLETED,
    ],
    [
      compiled(),
      compiled("selected-run", { systemPrompt: "[Malformed diagnostic JSON redacted]" }),
      COMPLETED,
    ],
    [compiled(), compiled("selected-run", { systemPrompt: "[Unserializable]" }), COMPLETED],
    [compiled(), { ...COMPLETED, runId: "newest-run" }],
  ])("keeps missing or unrelated compiled context unknown: %j", (...events) => {
    expect(reduce(events).compiledSearchContext).toBeUndefined();
  });

  it("uses the last compiled context for the selected completion", () => {
    expect(
      reduce([compiled(), compiled("selected-run", { systemPrompt: PRIVATE }), COMPLETED])
        .compiledSearchContext,
    ).toEqual({
      runtimeMarkerPresent: false,
      disabledSearchPresent: false,
      unavailableInstructionPresent: false,
      providerToolCount: 0,
    });
  });

  it.each([
    [{ tools: null }, null],
    [{ tools: [{ name: PRIVATE }] }, 1],
    [{ tools: Array.from({ length: 1_001 }, () => ({ name: PRIVATE })) }, 1_000],
  ])("bounds tool counts without retaining definitions: %j", (data, count) => {
    const evidence = reduce([compiled("selected-run", data), COMPLETED]);
    expect(evidence.compiledSearchContext?.providerToolCount).toBe(count);
    expect(JSON.stringify(evidence)).not.toContain(PRIVATE);
  });

  it.each([
    null,
    [],
    PRIVATE,
    { ...EXPECTED, runtimeMarkerPresent: PRIVATE },
    { ...EXPECTED, disabledSearchPresent: null },
    { ...EXPECTED, unavailableInstructionPresent: 1 },
    { ...EXPECTED, providerToolCount: -1 },
    { ...EXPECTED, providerToolCount: 1_001 },
    { ...EXPECTED, providerToolCount: 0.5 },
    { ...EXPECTED, providerToolCount: PRIVATE },
  ])("rejects malformed diagnostic fields: %j", (compiledSearchContext) => {
    const evidence = { ...reduce([]), compiledSearchContext };
    expect(() =>
      parseOpenClawToolEvidence(OPENCLAW_TOOL_EVIDENCE_MARKER + JSON.stringify(evidence)),
    ).toThrow("OpenClaw reduced tool evidence has an invalid schema");
  });

  it("reads legacy evidence and strips extra diagnostic fields from the artifact", () => {
    const legacy = reduce([]);
    expect(
      parseOpenClawToolEvidence(OPENCLAW_TOOL_EVIDENCE_MARKER + JSON.stringify(legacy)),
    ).toEqual(legacy);
    const evidence = {
      ...legacy,
      compiledSearchContext: { ...EXPECTED, privateRaw: PRIVATE },
    };
    expect(projectUnavailableSearchToolEvidenceArtifact(evidence).compiledSearchContext).toEqual(
      EXPECTED,
    );
    expect(JSON.stringify(projectUnavailableSearchToolEvidenceArtifact(evidence))).not.toContain(
      PRIVATE,
    );
  });

  it("runs the generated reducer without module closures or prompt disclosure", () => {
    const events = jsonLines([compiled(), COMPLETED]);
    const write = { output: "" };
    const database = {
      exec: () => undefined,
      close: () => undefined,
      prepare: () => ({ all: () => [{ eventJson: events }] }),
    };
    runInNewContext(
      buildOpenClawToolEvidenceReducerScript(),
      {
        require: () => ({
          DatabaseSync: function () {
            return database;
          },
        }),
        process: {
          argv: ["node", "fixture.db", "selected-session"],
          stdout: {
            write: (value: string) => {
              write.output += value;
            },
          },
        },
        URL,
        TextDecoder,
      },
      { timeout: 1_000 },
    );
    expect(parseOpenClawToolEvidence(write.output).compiledSearchContext).toEqual(EXPECTED);
    expect(write.output).not.toContain(PRIVATE);
  });
});
