// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

// Trust boundary: the Expect program receives a fixture-owned preset name.
// It compares that name with NemoClaw's rendered menu entries before it sends
// the matching numeric index and the literal confirmation Y.
// Exit codes: 2=preset timeout, 3=preset EOF, 4=confirmation timeout,
// 5=confirmation EOF, 6=post-confirmation timeout, and
// 7=requested preset absent from menu.
export const POLICY_ADD_EXPECT_SCRIPT = String.raw`
set timeout 60
match_max 20000
spawn env NEMOCLAW_NON_INTERACTIVE= node $env(NEMOCLAW_E2E_CLI) $env(NEMOCLAW_E2E_SANDBOX) policy-add
expect {
  -glob "*Choose preset*" {
    set preset_number ""
    foreach line [split $expect_out(buffer) "\n"] {
      if {[regexp {^[[:space:]]*([0-9]+)\)[[:space:]]+[●○][[:space:]]+([^[:space:]]+)} $line -> candidate_number candidate_name] && $candidate_name eq $env(NEMOCLAW_E2E_PRESET)} {
        set preset_number $candidate_number
        break
      }
    }
    if {$preset_number eq ""} {
      puts stderr "requested policy preset was not present in the interactive menu"
      exit 7
    }
    send -- "$preset_number\r"
  }
  timeout {
    puts stderr "timed out waiting for the policy preset prompt"
    exit 2
  }
  eof {
    puts stderr "policy-add exited before the policy preset prompt"
    exit 3
  }
}
expect {
  -glob "*Y/n*" {
    send -- "Y\r"
  }
  timeout {
    puts stderr "timed out waiting for the policy confirmation prompt"
    exit 4
  }
  eof {
    puts stderr "policy-add exited before the policy confirmation prompt"
    exit 5
  }
}
expect {
  eof {}
  timeout {
    puts stderr "policy-add did not exit after confirmation"
    exit 6
  }
}
set wait_result [wait]
exit [lindex $wait_result 3]
`;

export interface RunInteractivePolicyAddOptions {
  artifactName: string;
  cliEntrypoint: string;
  env: NodeJS.ProcessEnv;
  preset: string;
  sandboxName: string;
  timeoutMs: number;
}

export function runInteractivePolicyAdd(
  host: Pick<HostCliClient, "command">,
  options: RunInteractivePolicyAddOptions,
): Promise<ShellProbeResult> {
  return host.command("expect", ["-c", POLICY_ADD_EXPECT_SCRIPT], {
    artifactName: options.artifactName,
    env: {
      ...options.env,
      NEMOCLAW_E2E_CLI: options.cliEntrypoint,
      NEMOCLAW_E2E_PRESET: options.preset,
      NEMOCLAW_E2E_SANDBOX: options.sandboxName,
    },
    timeoutMs: options.timeoutMs,
  });
}
