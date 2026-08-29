// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseOpenClawAgentJsonDocuments,
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

  it("accepts a log-framed agent-output payload", () => {
    expect(
      parseOpenClawAgentText(
        `progress\n${JSON.stringify({ result: { payloads: [{ text: "NEMOCLAW_E2E_READY_6002" }] } })}`,
      ),
    ).toBe("NEMOCLAW_E2E_READY_6002");
  });

  it("joins top-level payload fragments", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          payloads: [{ text: "NEMOCLAW_" }, { text: "E2E_READY_6002" }],
        }),
      ),
    ).toBe("NEMOCLAW_\nE2E_READY_6002");
  });

  it("frames consecutive documents without treating braces in strings as structure", () => {
    const first = { result: { payloads: [{ text: 'Use {braces} and "quotes".' }] } };
    const second = { payloads: [{ text: "Second reply." }] };
    expect(
      parseOpenClawAgentText(
        `progress {not-json}\n${JSON.stringify(first)}\n${JSON.stringify(second)}`,
      ),
    ).toBe('Use {braces} and "quotes".\nSecond reply.');
  });

  it("extracts Brave response text without accepting echoed user or tool content", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({
          messages: [
            { role: "user", content: "SEARCH_TOKEN" },
            { role: "tool", content: "SEARCH_TOKEN" },
            { role: "assistant", content: "ASSISTANT_RESULT" },
          ],
          response: { text: "BRAVE_RESULT" },
        }),
      ),
    ).toBe("ASSISTANT_RESULT\nBRAVE_RESULT");
  });

  it("rejects structured tool-call records as reply evidence", () => {
    expect(
      parseOpenClawAgentText(
        JSON.stringify({ messages: [{ type: "tool_use", text: "56", input: {} }] }),
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

  it("fails closed in linear time for a long incomplete brace-rich stream", () => {
    expect(parseOpenClawAgentJsonDocuments("{".repeat(10_000))).toEqual([]);
  });
});
