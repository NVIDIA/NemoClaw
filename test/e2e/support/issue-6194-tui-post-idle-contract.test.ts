// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildIssue6194TuiExpectScript,
  ISSUE6194_TUI_SESSION,
  ISSUE6194_TUI_TIMEOUT_SEC,
} from "../live/issue-6194-tui-expect.ts";

describe("live TUI post-idle coverage contract (#6194)", () => {
  it("builds an expect flow for chat, slash status, network approval, and clean exit", () => {
    const script = buildIssue6194TuiExpectScript();

    expect(ISSUE6194_TUI_TIMEOUT_SEC).toBe(240);
    expect(ISSUE6194_TUI_SESSION).toBe("test-session");
    expect(script).toContain("log_file -noappend $capture");
    expect(script).toContain("spawn openshell sandbox exec --name $sandbox --tty");
    expect(script).toContain("openclaw tui --session test-session");
    expect(script).toContain('puts "ISSUE6194_MARK $name"');
    expect(script).toContain('send_log "ISSUE6194_MARK $name\\n"');
    expect(script).toContain("proc expect_or_exit");
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_initial 10 11",
    );
    expect(script).toContain("expect_or_exit {NEMOCLAW6194_CHAT_OK} chat_reply 20 21");
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_chat 22 23",
    );
    expect(script).toContain("/nemoclaw status");
    expect(script).toContain("Sandbox:[^\\r\\n]*$sandbox");
    expect(script).toContain(
      'expect_or_exit "Sandbox:[^\\r\\n]*$sandbox" slash_status_output 30 31',
    );
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_status 32 33",
    );
    expect(script).toContain("https://api.atlassian.com/oauth/token/accessible-resources");
    expect(script).toContain("mark network_approval_prompt");
    expect(script).toContain("mark network_approval_processed");
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_network_approval 56 57",
    );
    expect(script).toContain("mark clean_exit");
    expect(script).not.toContain("NEMOCLAW_ISSUE_6194_TUI_TIMEOUT_SEC");
    expect(script).not.toContain("(nemoclaw|sandbox|docker|status|managed|openclaw)");
    expect(script).not.toContain("approval-flow probe");

    const order = [
      "connected_idle_initial",
      "chat_reply",
      "connected_idle_after_chat",
      "slash_status_output",
      "connected_idle_after_status",
      "network_approval_prompt",
      "network_approval_processed",
      "connected_idle_after_network_approval",
      "clean_exit",
    ].map((marker) => script.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
