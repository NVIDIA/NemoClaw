// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildIssue6194TuiExpectScript,
  ISSUE6194_NETWORK_APPROVAL_ENDPOINT,
  ISSUE6194_TUI_SESSION_PREFIX,
  ISSUE6194_TUI_TIMEOUT_SEC,
} from "../live/issue-6194-tui-expect.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { stripTerminalControl } from "./issue-4434-tui-capture.ts";

describe("live TUI post-idle coverage contract (#6194)", () => {
  it("builds an expect flow for chat, slash status, network approval, and clean exit", () => {
    const script = buildIssue6194TuiExpectScript();

    expect(ISSUE6194_TUI_TIMEOUT_SEC).toBe(240);
    expect(ISSUE6194_TUI_SESSION_PREFIX).toBe("issue-6194-tui");
    expect(ISSUE6194_NETWORK_APPROVAL_ENDPOINT).toBe(
      "https://api.atlassian.com/oauth/token/accessible-resources",
    );
    expect(script).toContain("log_file -noappend $capture");
    expect(script).toContain("set session $env(NEMOCLAW_ISSUE_6194_SESSION)");
    expect(script).toContain("set networkEndpoint $env(NEMOCLAW_ISSUE_6194_NETWORK_ENDPOINT)");
    expect(script).toContain("spawn openshell sandbox exec --name $sandbox --tty");
    expect(script).toContain("openclaw tui --session $session");
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
    expect(script).toContain("call $networkEndpoint now");
    expect(script).toContain("mark network_approval_prompt");
    expect(script).toContain("mark network_approval_processed");
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_network_approval 56 57",
    );
    expect(script).toContain("mark clean_exit");

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

  it("redacts secrets from ANSI terminal captures before artifact publication", () => {
    const secret = "nvapi-secret-issue-6194";
    const secrets = new SecretStore({ NVIDIA_INFERENCE_API_KEY: secret }, (note?: string) => {
      throw new Error(note ?? "unexpected skip");
    });
    const capture = `before \u001b[32m${secret}\u001b[0m after`;

    const redactedCapture = secrets.redact(capture, [secret]);
    const plainCapture = stripTerminalControl(redactedCapture);

    expect(redactedCapture).not.toContain(secret);
    expect(plainCapture).not.toContain(secret);
    expect(plainCapture).toContain("[REDACTED]");
  });
});
