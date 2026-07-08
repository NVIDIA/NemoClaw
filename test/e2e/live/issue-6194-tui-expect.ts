// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE6194_TUI_TIMEOUT_SEC = 240;
export const ISSUE6194_TUI_SESSION_PREFIX = "issue-6194-tui";
export const ISSUE6194_NETWORK_APPROVAL_ENDPOINT =
  "https://api.atlassian.com/oauth/token/accessible-resources";

export function buildIssue6194TuiExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_6194_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_6194_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_6194_CAPTURE)
set session $env(NEMOCLAW_ISSUE_6194_SESSION)
set networkEndpoint $env(NEMOCLAW_ISSUE_6194_NETWORK_ENDPOINT)
log_file -noappend $capture
proc mark {name} {
  puts "ISSUE6194_MARK $name"
  send_log "ISSUE6194_MARK $name\\n"
}
proc expect_or_exit {pattern markName timeoutExit eofExit} {
  expect {
    -nocase -re $pattern { mark $markName }
    timeout {
      send "\\003"
      exit $timeoutExit
    }
    eof { exit $eofExit }
  }
}
spawn openshell sandbox exec --name $sandbox --tty -- sh -lc "export TERM=xterm-256color; cd /sandbox; openclaw tui --session $session"
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_initial 10 11
send -- "Reply with the three fragments joined by underscores: NEMOCLAW6194, CHAT, OK. Put only that joined token on its own line. Do not use tools.\\r"
expect_or_exit {NEMOCLAW6194_CHAT_OK} chat_reply 20 21
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_chat 22 23
send -- "/nemoclaw status\\r"
set slashStatusPattern [format {Sandbox:[^\\r\\n]*%s} $sandbox]
expect_or_exit $slashStatusPattern slash_status_output 30 31
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_status 32 33
# Use a public HTTPS origin outside the target's baseline policy to trigger the
# real OpenClaw network approval UI. A local endpoint can bypass that boundary.
# The assertion consumes only the local prompt and approval state, never the
# remote status or body, so endpoint availability is not a test oracle.
send -- "Use an available tool to call $networkEndpoint now. Do not describe it.\\r"
set networkApprovalPattern [format {(Sandbox:[^\\r\\n]*%s[^\\r\\n]*Network Rules[^\\r\\n]*(approve|allow)|Network Rules[^\\r\\n]*(approve|allow)[^\\r\\n]*Sandbox:[^\\r\\n]*%s)} $sandbox $sandbox]
expect {
  -nocase -re {(blocked|denied|rejected)} {
    send "\\003"
    exit 50
  }
  -nocase -re $networkApprovalPattern { mark network_approval_prompt }
  timeout {
    send "\\003"
    exit 51
  }
  eof { exit 52 }
}
send -- "a"
after 500
send -- "y\\r"
expect {
  -nocase -re {(approved|allowed|accepted|approval[^\\r\\n]*(processed|granted)|request[^\\r\\n]*(approved|allowed))} { mark network_approval_processed }
  -nocase -re {(blocked|denied|rejected)} {
    send "\\003"
    exit 53
  }
  timeout {
    send "\\003"
    exit 54
  }
  eof { exit 55 }
}
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_network_approval 56 57
send "\\003"
expect {
  eof {}
  timeout {
    send "\\003"
    expect {
      eof {}
      timeout { exit 40 }
    }
  }
}
mark clean_exit
exit 0
`;
}
