// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { containsAnswer } from "../../helpers/e2e-answer-assertions.ts";
import {
  nativeStateDoctorReportIsValid,
  nativeStateProcessIdentitiesAreValid,
  parseOpenClawAgentText,
} from "../fixtures/openclaw-agent-output.ts";

describe("OpenClaw agent-output fixture", () => {
  it("rejects echoed user messages as agent-response evidence", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          messages: [{ role: "user", content: "Reply with exactly: NEMOCLAW_E2E_READY_6002" }],
        }),
      ),
    ).toBe("");
  });

  it("ignores standalone JSON log records without a response envelope", () => {
    expect(parseOpenClawAgentText('progress {"text":"42"}')).toBe("");
    expect(parseOpenClawAgentText('progress {"text":"42"}\nstatus {"content":"42"}')).toBe("");
  });

  it("accepts a log-framed agent-output payload", () => {
    expect(
      parseOpenClawAgentText(
        `progress\n${JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "NEMOCLAW_E2E_READY_6002" }], meta: {} },
        })}`,
      ),
    ).toBe("NEMOCLAW_E2E_READY_6002");
  });

  it("accepts a completed tool replay whose final response and tool summary are successful", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          runId: "run-1",
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: "TOOLS_COMPLETE" }],
            meta: {
              replayInvalid: true,
              finalAssistantVisibleText: "TOOLS_COMPLETE",
              systemPromptReport: { tools: { entries: [{ name: "exec" }] } },
              toolSummary: { calls: 3, failures: 0, tools: ["exec"] },
            },
          },
        }),
      ),
    ).toBe("TOOLS_COMPLETE");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: "UNTRUSTED_PAYLOAD" }],
            meta: {
              replayInvalid: true,
              finalAssistantVisibleText: "TOOLS_COMPLETE",
              toolSummary: { calls: 1, failures: 0, tools: ["exec"] },
            },
          },
        }),
      ),
    ).toBe("");
  });

  it("accepts a log-framed array of agent-output payloads", () => {
    expect(
      parseOpenClawAgentText(
        `progress\n${JSON.stringify([
          { event: "progress", payloads: [{ text: "UNTRUSTED_PROGRESS" }] },
          { payloads: [{ text: "ARRAY_REPLY" }], meta: {} },
        ])}`,
      ),
    ).toBe("ARRAY_REPLY");
  });

  it("joins top-level payload fragments", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: "NEMOCLAW_" }, { text: "E2E_READY_6002" }],
          meta: {},
        }),
      ),
    ).toBe("NEMOCLAW_\nE2E_READY_6002");
  });

  it("rejects an answer-bearing envelope that also contains tool-call structure", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: "56" }],
          meta: {},
          tool_calls: [{ function: { name: "calculator", arguments: '{"value":56}' } }],
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          status: "ok",
          result: { payloads: [{ text: "56" }], meta: {} },
          function: { name: "calculator", parameters: { value: 56 } },
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: "hostname, date, and uptime completed successfully." }],
          meta: {},
          tool_calls: [{ function: { name: "exec", arguments: '{"command":"uptime"}' } }],
        }),
      ),
    ).toBe("");
  });

  it("accepts conversational text that only mentions tool-call capability", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: "I cannot make tool calls, but the answer is 42." }],
          meta: {},
        }),
      ),
    ).toBe("I cannot make tool calls, but the answer is 42.");
  });

  it("does not accept reasoning as visible reply evidence", () => {
    const reply = parseOpenClawAgentText(
      JSON.stringify({
        payloads: [{ content: "Wrong answer.", reasoning_content: "42" }],
        meta: {},
      }),
    );
    expect(reply).toBe("Wrong answer.");
    expect(containsAnswer(reply, "42")).toBe(false);

    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ content: "56", tool_calls: [{ name: "calculator", input: { value: 56 } }] }],
          meta: {},
        }),
      ),
    ).toBe("");
  });

  it("frames consecutive documents without treating braces in strings as structure", () => {
    const first = { payloads: [{ text: "UNTRUSTED_STANDALONE" }] };
    const second = { payloads: [{ text: 'Use {braces} and "quotes".' }], meta: {} };
    expect(
      parseOpenClawAgentText(
        `progress {not-json}\n${JSON.stringify(first)}\n${JSON.stringify(second)}`,
      ),
    ).toBe('Use {braces} and "quotes".');
  });

  it("rejects event and tool records containing nested reply-shaped data", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          event: "progress",
          data: { payloads: [{ text: "UNTRUSTED_PROGRESS" }], meta: {} },
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          event: "progress",
          status: "ok",
          result: { payloads: [{ text: "UNTRUSTED_GATEWAY_PROGRESS" }], meta: {} },
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          type: "tool_result",
          tool_call_id: "call-1",
          data: { payloads: [{ text: "UNTRUSTED_TOOL" }], meta: {} },
        }),
      ),
    ).toBe("");
  });

  it("rejects envelopes mixing assistant text with echoed tool content", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [
            { role: "user", content: "SEARCH_TOKEN" },
            { role: "tool", content: "SEARCH_TOKEN" },
            { role: "assistant", content: "ASSISTANT_RESULT" },
          ],
          meta: {},
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ role: "system", content: "42" }],
          meta: {},
        }),
      ),
    ).toBe("");
  });

  it("rejects structured tool-call records as reply evidence", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ messages: [{ type: "tool_use", text: "56", input: {} }] }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ type: "tool_result", tool_call_id: "call-1", content: "56" }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          response: { items: [{ type: "tool-result", toolCallId: "call-2", content: "56" }] },
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(JSON.stringify({ messages: [{ role: "toolResult", content: "56" }] })),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ payloads: [{ type: "toolResult", content: "56" }], meta: {} }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ messages: [{ role: "tool-result", content: "56" }] }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "56", tool_calls: [{}] } }],
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ output: { name: "read", param: { value: 56 }, payload: { text: "56" } } }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ response: { type: "function", payload: { text: "56" } } }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ response: { function: { name: "read" }, payload: { text: "56" } } }),
      ),
    ).toBe("");
  });

  it("rejects serialized and trailing malformed tool-call output", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: '{"name":"read","input":{"value":56}}' }],
          meta: {},
        }),
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        `${JSON.stringify({ payloads: [{ text: "56" }], meta: {} })}\n{"name":"read","input":{"value":56`,
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        `${JSON.stringify({ payloads: [{ text: "56" }], meta: {} })}\n{"role":"toolResult","content":"56"`,
      ),
    ).toBe("");
    expect(
      parseOpenClawAgentText(
        `${JSON.stringify({ payloads: [{ text: "56" }], meta: {} })}\n${String.raw`{"ty\u0070e":"funct\u0069on","funct\u0069on":{"name":"read"`}`,
      ),
    ).toBe("");
  });

  it("accepts an assistant reply with null or empty tool metadata", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ role: "assistant", content: "42", tool_calls: null }],
          meta: {},
        }),
      ),
    ).toBe("42");
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          status: "ok",
          result: {
            payloads: [{ role: "assistant", content: "42", tool_calls: [] }],
            meta: {},
          },
        }),
      ),
    ).toBe("42");
  });

  it("ignores tool schemas in successful OpenClaw run metadata (#10215)", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          runId: "run-1",
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: "42", mediaUrl: null }],
            meta: {
              tools: {
                entries: [
                  {
                    name: "read",
                    description: "Read a file",
                    input_schema: { type: "object" },
                  },
                ],
              },
            },
            finalAssistantRawText: "42",
            completion: { stopReason: "stop", finishReason: "stop" },
          },
        }),
      ),
    ).toBe("42");
  });

  it.each([
    ["timeout phase", { timeoutPhase: "provider" }],
    ["abandoned liveness", { livenessState: "abandoned" }],
    ["invalid replay", { replayInvalid: true }],
    ["incomplete-turn error", { error: { kind: "incomplete_turn" } }],
  ])("rejects reply evidence with declared %s metadata", (_label, meta) => {
    expect(parseOpenClawAgentText(JSON.stringify({ payloads: [{ text: "56" }], meta }))).toBe("");
  });
});

describe("OpenClaw native state doctor evidence", () => {
  const report = (findings: unknown[] = []) =>
    JSON.stringify({ ok: findings.length === 0, checksRun: 1, checksSkipped: 50, findings });
  const checkId = "core/doctor/state-integrity";
  const warning = { checkId, severity: "warning", path: "/unrelated-state-volume" };
  const clean = report();
  const unrelated = report([warning]);

  it.each([
    ["native startup text", 0, false, `native startup info\n${clean}`, true],
    ["unrelated warning", 1, false, unrelated, true],
    ["ok false with exit0", 0, false, unrelated, false],
    [
      "pathless detector exception",
      1,
      false,
      report([{ checkId, severity: "error", message: "health check threw: EACCES" }]),
      false,
    ],
    [
      "state directory permissions",
      1,
      false,
      report([{ ...warning, path: "/sandbox/.openclaw" }]),
      false,
    ],
    [
      "config permissions",
      1,
      false,
      report([{ ...warning, path: "/sandbox/.openclaw/openclaw.json" }]),
      false,
    ],
    ["timeout with exit1", 1, true, unrelated, false],
    [
      "different selected check",
      1,
      false,
      report([{ ...warning, checkId: "core/doctor/disk-space" }]),
      false,
    ],
    ["unavailable command", 127, false, unrelated, false],
    ["absent completed exit", null, false, unrelated, false],
    ["duplicate reports", 0, false, `${clean}\n${clean}`, false],
    ["malformed report", 0, false, '{"ok":true,', false],
    ["missing report", 0, false, "", false],
  ] as const)("classifies %s", (_name, exitCode, timedOut, stdout, expected) => {
    expect(nativeStateDoctorReportIsValid({ exitCode, timedOut, stdout })).toBe(expected);
  });
});

describe("OpenClaw native state process identities", () => {
  const identities = ` EUID EGID PID PPID COMMAND
    0 0 1 0 openshell-sandb
    998 998 892 1 bash
    998 998 1315 892 openclaw-gatewa
    998 998 2196 1 ps`;

  it.each([
    ["same-user gateway", 0, false, identities, true],
    ["distinct user and group IDs", 0, false, identities.replaceAll("998 998", "1000 999"), true],
    ["root gateway user", 0, false, identities.replace("998 998 1315", "0 998 1315"), false],
    ["root gateway group", 0, false, identities.replace("998 998 1315", "998 0 1315"), false],
    ["different gateway user", 0, false, identities.replace("998 998 1315", "999 998 1315"), false],
    [
      "different gateway group",
      0,
      false,
      identities.replace("998 998 1315", "998 999 1315"),
      false,
    ],
    ["missing gateway", 0, false, identities.replace("openclaw-gatewa", "node"), false],
    ["duplicate gateway", 0, false, `${identities}\n998 998 1316 892 openclaw-gatewa`, false],
    ["duplicate PID", 0, false, `${identities}\n998 998 892 1 bash`, false],
    ["non-Bash parent", 0, false, identities.replace("1 bash", "1 sh"), false],
    ["indirect parent", 0, false, identities.replace("892 1 bash", "892 900 bash"), false],
    ["non-root PID1 user", 0, false, identities.replace("0 0 1 0", "998 0 1 0"), false],
    ["non-root PID1 group", 0, false, identities.replace("0 0 1 0", "0 998 1 0"), false],
    ["malformed row", 0, false, `${identities}\ntruncated`, false],
    ["empty stdout", 0, false, "", false],
    ["failed command", 1, false, identities, false],
    ["timed-out command", 0, true, identities, false],
  ] as const)("classifies %s", (_name, exitCode, timedOut, stdout, expected) => {
    expect(nativeStateProcessIdentitiesAreValid({ exitCode, timedOut, stdout })).toBe(expected);
  });
});
