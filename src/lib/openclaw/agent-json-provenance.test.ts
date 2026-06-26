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

  it("strips ANSI, OSC, and control characters from failed tool details", () => {
    const hostile = [
      "\x1B[2Jexec failed",
      "\x1B]8;;https://example.invalid/phish\x07linked text\x1B]8;;\x07",
      "overwrite\rhidden",
      "erase\bmark",
      "\u0000done",
    ].join(" ");

    const lines = openClawAgentJsonProvenanceLines(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_hostile",
            toolName: "exec",
            isError: true,
            text: hostile,
          },
        ],
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("exec failed");
    expect(lines[0]).toContain("linked text");
    expect(lines[0]).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u);
    expect(lines[0]).not.toContain("https://example.invalid");
  });

  it("redacts secret-shaped values in failed tool output before stderr provenance", () => {
    const rawApiKey = "nvapi-abcdefghijklmnopqrstuvwxyz123456";
    const rawBearer = "secretbearertoken1234567890";
    const rawPassword = "hunter2-password-value";
    const rawPrivateKey = "private-key-material-that-must-not-leak";
    const privateKeyEnvelope = [
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
      rawPrivateKey,
      ["-----END", "PRIVATE KEY-----"].join(" "),
    ].join(" ");
    const lines = openClawAgentJsonProvenanceLines(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_secret",
            toolName: "exec",
            isError: true,
            stderr: [
              `NVIDIA_INFERENCE_API_KEY=${rawApiKey}`,
              `Authorization: Bearer ${rawBearer}`,
              `password: ${rawPassword}`,
              privateKeyEnvelope,
            ].join("\n"),
          },
        ],
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("<REDACTED>");
    expect(lines[0]).toContain("<REDACTED_PRIVATE_KEY>");
    expect(lines[0]).not.toContain(rawApiKey);
    expect(lines[0]).not.toContain(rawBearer);
    expect(lines[0]).not.toContain(rawPassword);
    expect(lines[0]).not.toContain(rawPrivateKey);
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

  it("scans balanced log-prefixed JSON candidates without reparsing every brace", () => {
    const noisyPrefix = Array.from(
      { length: 200 },
      (_, index) => `progress {not-json-${index}}`,
    ).join("\n");

    const lines = openClawAgentJsonProvenanceLines(
      `${noisyPrefix}\n${JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_noisy",
            toolName: "exec",
            isError: true,
            text: "exec failed after noisy progress output",
          },
        ],
      })}`,
    );

    expect(lines).toEqual([
      "[openclaw provenance] failed tool result (exec call_noisy): exec failed after noisy progress output",
    ]);
  });

  it("bounds provenance traversal for deeply nested sandbox-controlled JSON", () => {
    const nested = `${'{"child":'.repeat(2_000)}{"payloads":[{"text":"too deep"}]}${"}".repeat(2_000)}`;

    expect(() => openClawAgentJsonProvenanceLines(nested)).not.toThrow();
    expect(openClawAgentJsonProvenanceLines(nested)).toEqual([]);
  });
});
