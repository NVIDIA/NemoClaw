// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

export const ISSUE6194_TUI_TIMEOUT_SEC = 240;

export function readOptionalIssue6194Capture(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== "ENOENT") {
      throw error;
    }
    return "";
  }
}

export function buildIssue6194TuiExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_6194_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_6194_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_6194_CAPTURE)
log_file -a $capture
spawn openshell sandbox exec --name $sandbox --tty -- sh -lc {export TERM=xterm-256color; cd /sandbox; openclaw tui}
expect {
  -nocase -re {connected[^\\r\\n]*idle} { puts "ISSUE6194_MARK connected_idle_initial" }
  timeout {
    send "\\003"
    exit 10
  }
  eof { exit 11 }
}
send -- "Reply with the three fragments joined by underscores: NEMOCLAW6194, CHAT, OK. Put only that joined token on its own line. Do not use tools.\\r"
expect {
  -nocase -re {NEMOCLAW6194_CHAT_OK} { puts "ISSUE6194_MARK chat_reply" }
  timeout {
    send "\\003"
    exit 20
  }
  eof { exit 21 }
}
expect {
  -nocase -re {connected[^\\r\\n]*idle} { puts "ISSUE6194_MARK connected_idle_after_chat" }
  timeout {
    send "\\003"
    exit 22
  }
  eof { exit 23 }
}
send -- "/nemoclaw status\\r"
expect {
  -nocase -re "Sandbox:[^\\r\\n]*$sandbox" { puts "ISSUE6194_MARK slash_status_output" }
  timeout {
    send "\\003"
    exit 30
  }
  eof { exit 31 }
}
expect {
  -nocase -re {connected[^\\r\\n]*idle} { puts "ISSUE6194_MARK connected_idle_after_status" }
  timeout {
    send "\\003"
    exit 32
  }
  eof { exit 33 }
}
send -- "Use an available tool to call https://api.atlassian.com/oauth/token/accessible-resources now. Do not describe it.\\r"
expect {
  -nocase -re {(blocked|denied|rejected)} {
    send "\\003"
    exit 50
  }
  -nocase -re {(Network Rules|pending|approve)} { puts "ISSUE6194_MARK network_approval_text" }
  timeout {
    send "\\003"
    exit 51
  }
  eof { exit 52 }
}
expect {
  -nocase -re "(Sandbox:[^\\r\\n]*$sandbox[^\\r\\n]*(pending|approve)|(pending|approve)[^\\r\\n]*Sandbox:[^\\r\\n]*$sandbox)" { puts "ISSUE6194_MARK network_approval_prompt" }
  timeout {
    send "\\003"
    exit 53
  }
  eof { exit 54 }
}
send -- "a"
after 500
send -- "y\\r"
expect {
  -nocase -re {(approved|allowed|accepted|approval[^\\r\\n]*(processed|granted)|request[^\\r\\n]*(approved|allowed))} { puts "ISSUE6194_MARK network_approval_processed" }
  -nocase -re {(blocked|denied|rejected)} {
    send "\\003"
    exit 55
  }
  timeout {
    send "\\003"
    exit 56
  }
  eof { exit 57 }
}
expect {
  -nocase -re {connected[^\\r\\n]*idle} { puts "ISSUE6194_MARK connected_idle_after_network_approval" }
  timeout {
    send "\\003"
    exit 58
  }
  eof { exit 59 }
}
send "\\003"
expect {
  eof {
    puts "ISSUE6194_MARK clean_exit"
    exit 0
  }
  timeout {
    send "\\003"
    expect {
      eof {
        puts "ISSUE6194_MARK clean_exit"
        exit 0
      }
      timeout { exit 40 }
    }
  }
}
`;
}
