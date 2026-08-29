// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  openClawAgentResponseRecord,
  openClawAgentIncompleteTurnSignal,
  openClawAgentJsonProvenanceLines,
  parseOpenClawJsonDocuments,
  openClawUnframedJsonText,
} from "./agent-json-provenance";

describe("parseOpenClawJsonDocuments", () => {
  it("parses clean object and array documents", () => {
    expect(parseOpenClawJsonDocuments('{"payloads":[{"text":"one"}]}')).toEqual([
      { payloads: [{ text: "one" }] },
    ]);
    expect(parseOpenClawJsonDocuments('[{"text":"one"},{"text":"two"}]')).toEqual([
      { text: "one" },
      { text: "two" },
    ]);
  });

  it("frames log-prefixed objects and arrays while respecting JSON strings", () => {
    expect(
      parseOpenClawJsonDocuments(
        'progress {not-json}\n{"text":"object with {braces}"}\n[{"text":"array with [brackets]"}]',
      ),
    ).toEqual([{ text: "object with {braces}" }, { text: "array with [brackets]" }]);
  });

  it("ignores malformed and incomplete candidates", () => {
    expect(parseOpenClawJsonDocuments('progress {not-json}\n{"text":"incomplete"')).toEqual([]);
  });

  it("recovers a complete response record after an unclosed log fragment", () => {
    const response = {
      status: "timeout",
      result: { payloads: [{ text: "partial" }], meta: { timeoutPhase: "provider" } },
    };
    const raw = `tool {"name":"read"\n${JSON.stringify(response)}`;

    expect(parseOpenClawJsonDocuments(raw)).toEqual([response]);
    expect(openClawAgentIncompleteTurnSignal(raw)?.timeoutPhase).toBe("provider");
  });

  it("preserves only log and malformed text outside complete JSON documents", () => {
    const response = JSON.stringify({ payloads: [{ text: "42" }], meta: {} });
    expect(openClawUnframedJsonText(response).trim()).toBe("");
    expect(openClawUnframedJsonText(`progress\r\n${response}\r\ntrailing`)).toBe(
      "progress\r\n\n\r\ntrailing",
    );
    expect(openClawUnframedJsonText(`${response}\n{\"name\":\"read\"`)).toContain(
      '{"name":"read"',
    );
  });

  it("fails closed in linear time for a long incomplete brace-rich stream", () => {
    expect(parseOpenClawJsonDocuments("{".repeat(10_000))).toEqual([]);
  });
});

describe("openClawAgentResponseRecord", () => {
  it("accepts documented local and gateway response envelopes", () => {
    const local = { payloads: [{ text: "local" }], meta: {} };
    const gatewayResult = { payloads: [{ text: "gateway" }], meta: {} };
    expect(openClawAgentResponseRecord(local)).toBe(local);
    expect(openClawAgentResponseRecord({ status: "ok", result: gatewayResult })).toBe(
      gatewayResult,
    );
  });

  it("rejects standalone payloads and event records", () => {
    expect(openClawAgentResponseRecord({ payloads: [{ text: "unbound" }] })).toBeNull();
    expect(
      openClawAgentResponseRecord({
        event: "progress",
        payloads: [{ text: "untrusted" }],
        meta: {},
      }),
    ).toBeNull();
    expect(
      openClawAgentResponseRecord({
        event: "progress",
        status: "ok",
        result: { payloads: [{ text: "untrusted" }], meta: {} },
      }),
    ).toBeNull();
  });
});

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

  it("redacts URL credentials in failed tools and untrusted child excerpts", () => {
    const credential = "service-user:service-password";
    const credentialUrl = `https://${credential}@example.invalid/path`;
    const childPayload = [
      "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
      credentialUrl,
      "<<<END_UNTRUSTED_CHILD_RESULT>>>",
    ].join("\n");
    const lines = openClawAgentJsonProvenanceLines(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_url_secret",
            toolName: "fetch",
            isError: true,
            stderr: credentialUrl,
          },
          { role: "user", content: childPayload },
        ],
      }),
    );
    const failure = lines.find((line) => line.includes("failed tool result"));
    const childExcerpt = lines.find((line) => line.includes("untrusted child excerpt"));

    expect(failure).toBeDefined();
    expect(childExcerpt).toBeDefined();
    expect(failure).toContain("https://example.invalid/path");
    expect(childExcerpt).toContain("https://example.invalid/path");
    expect(failure).not.toContain(credential);
    expect(childExcerpt).not.toContain(credential);
  });

  it("sanitizes and redacts untrusted failed tool labels", () => {
    const rawApiKey = "nvapi-tool-label-secret-1234567890";
    const lines = openClawAgentJsonProvenanceLines(
      JSON.stringify({
        messages: [
          {
            role: "toolResult",
            toolCallId: "\x1B]8;;https://example.invalid/phish\x07call_hostile\x1B]8;;\x07",
            toolName: `\x1B[2Jexec\nNVIDIA_API_KEY=${rawApiKey}`,
            isError: true,
            text: "failed",
          },
        ],
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NVIDIA_API_KEY=<REDACTED>");
    expect(lines[0]).toContain("call_hostile");
    expect(lines[0]).not.toContain(rawApiKey);
    expect(lines[0]).not.toContain("https://example.invalid");
    expect(lines[0]).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u);
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

describe("openClawAgentIncompleteTurnSignal", () => {
  it("returns null for a healthy turn", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [{ text: "PONG" }], meta: { livenessState: "working" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("detects an incomplete_turn error kind on the run metadata", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { error: { kind: "incomplete_turn" } } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers).toEqual(["error.kind=incomplete_turn"]);
  });

  it("detects an abandoned liveness state on the run metadata", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { livenessState: "abandoned" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers).toEqual(["livenessState=abandoned"]);
  });

  it("detects replayInvalid on the run metadata", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { replayInvalid: true } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers).toEqual(["replayInvalid=true"]);
  });

  it("reads run metadata that sits at the envelope root", () => {
    const raw = JSON.stringify({ payloads: [{ text: "x" }], meta: { livenessState: "abandoned" } });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers).toEqual(["livenessState=abandoned"]);
  });

  it("reports every marker present without duplicates", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        payloads: [],
        meta: {
          error: { kind: "incomplete_turn" },
          livenessState: "abandoned",
          replayInvalid: true,
        },
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers.sort()).toEqual([
      "error.kind=incomplete_turn",
      "livenessState=abandoned",
      "replayInvalid=true",
    ]);
  });

  it("ignores replayInvalid inside a successful tool result", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        messages: [{ role: "toolResult", content: { replayInvalid: true } }],
        payloads: [{ text: "done" }],
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores an abandoned liveness state inside a successful tool result", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        messages: [{ role: "toolResult", content: { livenessState: "abandoned" } }],
        payloads: [{ text: "done" }],
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores an incomplete_turn kind inside a successful tool result", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        messages: [{ role: "toolResult", content: { error: { kind: "incomplete_turn" } } }],
        payloads: [{ text: "done" }],
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores markers inside tool-call arguments", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        meta: {
          pendingToolCalls: [{ id: "c1", name: "write", arguments: '{"replayInvalid":true}' }],
        },
        payloads: [{ text: "done" }],
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores a replayInvalid that is not literally true", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { replayInvalid: "false" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores a non-abandoned liveness state", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { livenessState: "blocked" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores a terminal error kind that is not incomplete_turn", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { error: { kind: "retry_limit" } } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("reads markers out of log-prefixed JSON framing", () => {
    const raw = `2026-08-12 INFO starting\n${JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { livenessState: "abandoned" } },
    })}`;
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers).toEqual(["livenessState=abandoned"]);
  });

  it("ignores markers in a preceding JSON log record when the response is healthy", () => {
    const raw = [
      JSON.stringify({ event: "progress", meta: { replayInvalid: true } }),
      JSON.stringify({
        status: "ok",
        result: { payloads: [{ text: "done" }], meta: { livenessState: "working" } },
      }),
    ].join("\n");

    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("ignores a trailing JSON progress record after a healthy local response", () => {
    const raw = [
      JSON.stringify({ payloads: [{ text: "done" }], meta: { livenessState: "working" } }),
      JSON.stringify({ event: "progress", meta: { replayInvalid: true } }),
    ].join("\n");

    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it("returns null when stdout carries no JSON at all", () => {
    expect(openClawAgentIncompleteTurnSignal("not json")).toBeNull();
  });

  it("detects a declared timeout phase on the run metadata (#8723)", () => {
    const raw = JSON.stringify({
      status: "timeout",
      result: {
        payloads: [{ text: "1\n2\n3" }],
        meta: { replayInvalid: false, livenessState: "blocked", timeoutPhase: "provider" },
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toEqual({
      markers: ["timeoutPhase=provider"],
      timeoutPhase: "provider",
    });
  });

  it("classifies a timeout phase the measurements never observed (#8723)", () => {
    const raw = JSON.stringify({
      status: "timeout",
      result: { payloads: [], meta: { timeoutPhase: "gateway_draining" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.timeoutPhase).toBe("gateway_draining");
  });

  it("ignores a timeout phase inside a successful tool result (#8723)", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: {
        messages: [{ role: "toolResult", content: { timeoutPhase: "provider" } }],
        payloads: [{ text: "done" }],
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
  });

  it.each(["", "   ", null, 3, true])(
    "ignores a timeout phase that carries no value [case %#] (#8723)",
    (timeoutPhase) => {
      const raw = JSON.stringify({
        status: "ok",
        result: { payloads: [], meta: { timeoutPhase } },
      });
      expect(openClawAgentIncompleteTurnSignal(raw)).toBeNull();
    },
  );

  it("leaves the timeout phase absent for an abandoned turn that did not time out (#8723)", () => {
    const raw = JSON.stringify({
      status: "ok",
      result: { payloads: [], meta: { livenessState: "abandoned" } },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.timeoutPhase).toBeUndefined();
  });

  it("reports the timeout phase alongside every other marker present (#8723)", () => {
    const raw = JSON.stringify({
      status: "timeout",
      result: {
        payloads: [],
        meta: {
          error: { kind: "incomplete_turn" },
          livenessState: "abandoned",
          replayInvalid: true,
          timeoutPhase: "post_turn",
        },
      },
    });
    expect(openClawAgentIncompleteTurnSignal(raw)?.markers.sort()).toEqual([
      "error.kind=incomplete_turn",
      "livenessState=abandoned",
      "replayInvalid=true",
      "timeoutPhase=post_turn",
    ]);
  });
});
