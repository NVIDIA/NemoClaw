// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  SANDBOX_OPENCLAW_STATE_DIR,
  agentSessionsDir,
  agentSessionsStorePath,
  sessionOwnedFilenameFindClause,
  validateAgentId,
  validateSessionId,
  validateSessionKey,
} from "../../../../../dist/lib/actions/sandbox/sessions/paths";

describe("session path helpers", () => {
  it("anchors agent sessions under /sandbox/.openclaw", () => {
    expect(SANDBOX_OPENCLAW_STATE_DIR).toBe("/sandbox/.openclaw");
    expect(agentSessionsDir("main")).toBe("/sandbox/.openclaw/agents/main/sessions");
    expect(agentSessionsStorePath("main")).toBe(
      "/sandbox/.openclaw/agents/main/sessions/sessions.json",
    );
  });

  it("accepts a wide range of legitimate agent ids", () => {
    expect(validateAgentId("main")).toBe("main");
    expect(validateAgentId("work_assistant")).toBe("work_assistant");
    expect(validateAgentId("agent-42.beta")).toBe("agent-42.beta");
  });

  it("rejects agent ids with shell metacharacters or path separators", () => {
    expect(() => validateAgentId("main/extra")).toThrow(/Invalid agent id/);
    expect(() => validateAgentId("..")).toThrow(/Invalid agent id/);
    expect(() => validateAgentId("main; rm -rf /")).toThrow(/Invalid agent id/);
    expect(() => validateAgentId("")).toThrow(/Invalid agent id/);
  });

  it("accepts canonical OpenClaw session keys", () => {
    expect(validateSessionKey("agent:main:main")).toBe("agent:main:main");
    expect(validateSessionKey("agent:main:telegram:thread")).toBe("agent:main:telegram:thread");
    expect(validateSessionKey("agent:main:whatsapp:group:120363051234567890@g.us")).toBe(
      "agent:main:whatsapp:group:120363051234567890@g.us",
    );
  });

  it("rejects session keys with quotes, backticks, $, backslash, or newline", () => {
    expect(() => validateSessionKey("agent:main:'evil'")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:\"evil\"")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:`evil`")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:$evil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:evil\\")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:\nevil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("")).toThrow(/Invalid session key/);
  });

  it("validates session ids for shell-safe glob usage", () => {
    expect(validateSessionId("session-abc123")).toBe("session-abc123");
    expect(validateSessionId("01HZX7QWERTY")).toBe("01HZX7QWERTY");
  });

  it("rejects session ids that could escape a shell glob", () => {
    expect(() => validateSessionId("../etc/passwd")).toThrow(/Refusing to operate/);
    expect(() => validateSessionId("session id with space")).toThrow(/Refusing to operate/);
    expect(() => validateSessionId("session*")).toThrow(/Refusing to operate/);
  });

  it("builds a find clause that matches owned shapes only", () => {
    const clause = sessionOwnedFilenameFindClause("abc");
    expect(clause).toBe("\\( -name 'abc.*' -o -name 'abc-topic-*' \\)");
  });

  it("validates session id when building the find clause", () => {
    expect(() => sessionOwnedFilenameFindClause("abc*")).toThrow(/Refusing to operate/);
    expect(() => sessionOwnedFilenameFindClause("abc def")).toThrow(/Refusing to operate/);
  });
});
