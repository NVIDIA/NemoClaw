// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildCanonicalSessionKey,
  DEFAULT_AGENT_ID,
  parseAgentIdFromSessionKey,
  validateAgentId,
  validateSessionKey,
} from "./paths";

describe("session path helpers", () => {
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

  it("rejects session keys with quotes, backticks, $, backslash, or whitespace controls", () => {
    expect(() => validateSessionKey("agent:main:'evil'")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey('agent:main:"evil"')).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:`evil`")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:$evil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:evil\\")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:\nevil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("")).toThrow(/Invalid session key/);
  });

  it("extracts the agent id from a canonical session key", () => {
    expect(parseAgentIdFromSessionKey("agent:main:main")).toBe("main");
    expect(parseAgentIdFromSessionKey("agent:work:telegram:t-1")).toBe("work");
    expect(parseAgentIdFromSessionKey("not-canonical")).toBeNull();
  });

  it("builds canonical session keys", () => {
    expect(buildCanonicalSessionKey("main", "main")).toBe("agent:main:main");
    expect(buildCanonicalSessionKey("work", "telegram:t-1")).toBe("agent:work:telegram:t-1");
    expect(buildCanonicalSessionKey("main", "agent:work:telegram:t-1")).toBe(
      "agent:work:telegram:t-1",
    );
  });

  it("exposes a sensible default agent id", () => {
    expect(DEFAULT_AGENT_ID).toBe("main");
  });
});
