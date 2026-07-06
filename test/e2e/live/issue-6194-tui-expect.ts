// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const ISSUE6194_TUI_TIMEOUT_SEC = 240;
export const ISSUE6194_TUI_SESSION = "test-session";

export function buildIssue6194TuiExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_6194_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_6194_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_6194_CAPTURE)
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
spawn openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; openclaw tui --session ${ISSUE6194_TUI_SESSION}}
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_initial 10 11
send -- "Reply with the three fragments joined by underscores: NEMOCLAW6194, CHAT, OK. Put only that joined token on its own line. Do not use tools.\\r"
expect_or_exit {NEMOCLAW6194_CHAT_OK} chat_reply 20 21
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_chat 22 23
send -- "/nemoclaw status\\r"
expect_or_exit "Sandbox:[^\\r\\n]*$sandbox" slash_status_output 30 31
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_status 32 33
send -- "Use an available tool to call https://api.atlassian.com/oauth/token/accessible-resources now. Do not describe it.\\r"
expect {
  -nocase -re {(blocked|denied|rejected)} {
    send "\\003"
    exit 50
  }
  -nocase -re "(Sandbox:[^\\r\\n]*$sandbox[^\\r\\n]*(Network Rules|pending|approve)|(Network Rules|pending|approve)[^\\r\\n]*Sandbox:[^\\r\\n]*$sandbox)" { mark network_approval_prompt }
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
  eof {
    mark clean_exit
    exit 0
  }
  timeout {
    send "\\003"
    expect {
      eof {
        mark clean_exit
        exit 0
      }
      timeout { exit 40 }
    }
  }
}
`;
}
