// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { openClawAgentJsonProvenanceLines } from "./agent-json-provenance";

describe("openClawAgentJsonProvenanceLines", () => {
  it("returns no provenance for plain successful assistant payloads", () => {
    expect(
      openClawAgentJsonProvenanceLines(JSON.stringify({ result: { payloads: [{ text: "42" }] } })),
    ).toEqual([]);
  });

  it("surfaces failed tool results independent of the bare-python trigger", () => {
    const lines = openClawAgentJsonProvenanceLines(
      JSON.stringify({
        result: {
          messages: [
            {
              role: "toolResult",
              content: [
                {
                  type: "toolResult",
                  toolCallId: "call_false",
                  toolName: "exec",
                  isError: true,
                  text: "exec failed: /bin/false exited 1",
                },
              ],
            },
          ],
          payloads: [{ text: "Done." }],
        },
      }),
    );

    expect(lines).toEqual([
      "[openclaw provenance] failed tool result (exec call_false): exec failed: /bin/false exited 1",
    ]);
  });

  it("labels untrusted child-agent result framing from log-prefixed JSON", () => {
    const childPayload = [
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
      "Found an unverified URL: https://github.com/openclaw/openclaw/releases",
      "<<<END_UNTRUSTED_CHILD_RESULT>>>",
    ].join("\n");

    const lines = openClawAgentJsonProvenanceLines(
      `progress\n${JSON.stringify({
        result: {
          messages: [{ role: "user", content: childPayload }],
          payloads: [{ text: "The child found a release URL." }],
        },
      })}`,
    );

    expect(lines[0]).toContain("untrusted child result present");
    expect(lines[1]).toContain("Found an unverified URL");
  });
});
