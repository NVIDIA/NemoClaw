// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { SecretStore } from "../fixtures/secrets.ts";
import {
  buildIssue6194OpenShellApprovalExpectScript,
  buildIssue6194TuiExpectScript,
  ISSUE6194_NETWORK_APPROVAL_ENDPOINT,
  ISSUE6194_NETWORK_APPROVAL_HOST,
  ISSUE6194_TUI_SESSION_PREFIX,
  ISSUE6194_TUI_TIMEOUT_SEC,
} from "../live/issue-6194-tui-expect.ts";
import { stripTerminalControl } from "./issue-4434-tui-capture.ts";

describe("live TUI post-idle coverage contract (#6194)", () => {
  it("builds an expect flow for chat, slash status, return to idle, and clean exit", () => {
    const script = buildIssue6194TuiExpectScript();

    expect(ISSUE6194_TUI_TIMEOUT_SEC).toBe(240);
    expect(ISSUE6194_TUI_SESSION_PREFIX).toBe("issue-6194-tui");
    expect(script).toContain("log_file -noappend $capture");
    expect(script).toContain("set session $env(NEMOCLAW_ISSUE_6194_SESSION)");
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
    expect(script).toContain("expect_or_exit {NemoClaw Status} slash_status_output 30 31");
    expect(script).toContain(
      "expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_status 32 33",
    );
    expect(script).toContain("mark clean_exit");

    const markers = [
      "connected_idle_initial",
      "chat_reply",
      "connected_idle_after_chat",
      "slash_status_output",
      "connected_idle_after_status",
      "clean_exit",
    ];
    for (const marker of markers) {
      expect(script.match(new RegExp(`\\b${marker}\\b`, "gu")) ?? []).toHaveLength(1);
    }
    const order = markers.map((marker) => script.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("drives a direct blocked request through the real OpenShell approval surface", () => {
    const script = buildIssue6194OpenShellApprovalExpectScript();

    expect(ISSUE6194_NETWORK_APPROVAL_ENDPOINT).toBe(
      "https://api.atlassian.com/oauth/token/accessible-resources",
    );
    expect(ISSUE6194_NETWORK_APPROVAL_HOST).toBe("api.atlassian.com");
    expect(script).toContain("spawn openshell term");
    expect(script).not.toContain("openshell rule clear");
    expect(script).toContain("exec openshell sandbox list --names");
    expect(script).toContain("exec openshell rule get $sandbox --status pending");
    expect(script).toContain("set expectedEmpty \"No network rules for sandbox '$sandbox'\"");
    expect(script).toContain("set termSpawn $spawn_id");
    expect(script).toContain(
      "expect_exact_or_exit $termSpawn {Sandboxes} openshell_dashboard 64 65",
    );
    expect(script.match(/send -i \$termSpawn -- "\\t"/gu) ?? []).toHaveLength(2);
    expect(script).toContain('send -i $termSpawn -- "r"');
    expect(script).toContain(
      "expect_exact_or_exit $termSpawn {Network Rules} network_rules_focused",
    );
    expect(script).toContain(
      "spawn -noecho openshell sandbox exec --name $sandbox --no-tty --timeout 40 -- /usr/bin/curl -sS --connect-timeout 5 --max-time 30 -o /dev/null $networkEndpoint",
    );
    expect(script).toContain("set curlSpawn $spawn_id");
    expect(script).toContain("expect -i $curlSpawn");
    expect(script).toContain("catch {wait -i $curlSpawn} curlWait");
    expect(script).toContain(
      "set chunkCount [regexp -all -line {^[[:space:]]*Chunk:} $pendingOutput]",
    );
    expect(script).toContain("Network Rules:[^\\r\\n]*1 chunk");
    expect(script).toContain("Status:[[:space:]]*pending");
    expect(script).toContain("Binary:[[:space:]]*/usr/bin/curl");
    expect(script).toContain(
      "expect_or_exit $termSpawn {Status:[^\\r\\n]*pending} network_rule_detail",
    );
    expect(script).toContain(
      "expect_or_exit $termSpawn {Binary:[^\\r\\n]*/usr/bin/curl} network_rule_detail_binary",
    );
    expect(script).toContain(
      "expect_or_exit $termSpawn {\\[a\\][^\\r\\n]*Approve} network_rule_approve_action",
    );
    expect(script).toContain('send -i $termSpawn -- "a"');
    expect(script).toContain(
      "expect_or_exit $termSpawn {Approved '[^']+'[^\\r\\n]*policy v[0-9]+} network_approval_processed",
    );
    expect(script).not.toContain('send -i $termSpawn -- "A"');
    expect(script).not.toContain('send -i $termSpawn -- "y"');

    const markers = [
      "sole_sandbox_verified",
      "pending_queue_empty",
      "openshell_dashboard",
      "openshell_sandbox_listed",
      "openshell_sandbox_detail",
      "openshell_sandbox_detail_name",
      "network_rules_focused",
      "network_request_triggered",
      "network_request_completed",
      "network_rule_singleton",
      "network_rule_endpoint",
      "network_rule_detail",
      "network_rule_detail_binary",
      "network_rule_detail_endpoint",
      "network_rule_approve_action",
      "network_approval_processed",
      "openshell_clean_exit",
    ];
    const order = markers.map((marker) => script.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it.each([
    "blocked",
    "denied",
    "rejected",
  ])("does not map assistant prose containing '%s' to the former refusal exit", (word) => {
    const tuiScript = buildIssue6194TuiExpectScript();
    const approvalScript = buildIssue6194OpenShellApprovalExpectScript();
    const assistantTranscript = `The request was ${word} because this model has no network tools.`;

    expect(assistantTranscript).toContain(word);
    expect(tuiScript).not.toContain("Use an available tool");
    expect(tuiScript).not.toContain("NEMOCLAW_ISSUE_6194_NETWORK_ENDPOINT");
    expect(tuiScript).not.toContain("(blocked|denied|rejected)");
    expect(`${tuiScript}\n${approvalScript}`).not.toMatch(/exit 50\b/u);
    expect(approvalScript).not.toContain("assistantTranscript");
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
