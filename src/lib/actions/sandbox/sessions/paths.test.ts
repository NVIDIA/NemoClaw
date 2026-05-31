// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateAgentId,
  validateSessionKey,
} from "../../../../../dist/lib/actions/sandbox/sessions/paths";

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

  it("rejects session keys with quotes, backticks, $, backslash, or newline", () => {
    expect(() => validateSessionKey("agent:main:'evil'")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:\"evil\"")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:`evil`")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:$evil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:evil\\")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("agent:main:\nevil")).toThrow(/Invalid session key/);
    expect(() => validateSessionKey("")).toThrow(/Invalid session key/);
  });
});
