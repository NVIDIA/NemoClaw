// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";

export const ISSUE6194_TUI_TIMEOUT_SEC = 240;
export const ISSUE6194_TUI_EXIT_TIMEOUT_SEC = 10;
export const ISSUE6194_OPENSHELL_DASHBOARD_TIMEOUT_SEC = 30;
export const ISSUE6194_OPENSHELL_APPROVAL_TIMEOUT_BUFFER_SEC = 120;
export const ISSUE6194_TUI_SESSION_PREFIX = "issue-6194-tui";
export const ISSUE6194_NETWORK_APPROVAL_ENDPOINT =
  "https://api.atlassian.com/oauth/token/accessible-resources";
export const ISSUE6194_NETWORK_APPROVAL_HOST = "api.atlassian.com";

export type Issue6194Capture = {
  exists: boolean;
  contents: string;
};

export function precreateIssue6194Capture(path: string): void {
  writeFileSync(path, "", { mode: 0o600 });
}

export function readIssue6194Capture(path: string): Issue6194Capture {
  try {
    return { exists: true, contents: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { exists: false, contents: "" };
    }
    throw error;
  }
}

export function buildIssue6194TuiExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_6194_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_6194_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_6194_CAPTURE)
set session $env(NEMOCLAW_ISSUE_6194_SESSION)
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
expect_or_exit {NemoClaw Status} slash_status_output 30 31
expect_or_exit {connected[^\\r\\n]*idle} connected_idle_after_status 32 33
# Network-rule approvals belong to the separate OpenShell terminal UI. Keep
# this OpenClaw TUI regression scoped to inputs it can perform directly so a
# tool-less hosted model cannot turn assistant prose into a test oracle.
send "\\003"
set savedTimeout $timeout
set timeout ${ISSUE6194_TUI_EXIT_TIMEOUT_SEC}
expect {
  eof {}
  -nocase -re {press ctrl\\+c again to exit} {
    mark exit_confirmation
    send "\\003"
    expect {
      eof {}
      timeout { exit 40 }
    }
  }
  timeout { exit 39 }
}
set timeout $savedTimeout
mark clean_exit
exit 0
`;
}

export function buildIssue6194OpenShellApprovalExpectScript(): string {
  return `set timeout $env(NEMOCLAW_ISSUE_6194_TUI_TIMEOUT)
set sandbox $env(NEMOCLAW_ISSUE_6194_SANDBOX)
set capture $env(NEMOCLAW_ISSUE_6194_CAPTURE)
set triggerCapture $env(NEMOCLAW_ISSUE_6194_TRIGGER_CAPTURE)
set ruleCapture $env(NEMOCLAW_ISSUE_6194_RULE_CAPTURE)
set policyCapture $env(NEMOCLAW_ISSUE_6194_POLICY_CAPTURE)
set networkEndpoint $env(NEMOCLAW_ISSUE_6194_NETWORK_ENDPOINT)
set networkHost $env(NEMOCLAW_ISSUE_6194_NETWORK_HOST)
log_file -noappend $capture
proc mark {name} {
  puts "ISSUE6194_MARK $name"
  send_log "ISSUE6194_MARK $name\\n"
}
proc stop_spawn {target} {
  catch {send -i $target "\\003"}
  catch {close -i $target}
  catch {wait -i $target -nowait}
}
proc write_capture {path value} {
  set handle [open $path w]
  puts -nonewline $handle $value
  close $handle
}
proc expect_or_exit {target pattern markName timeoutExit eofExit} {
  expect {
    -i $target
    -nocase -re $pattern { mark $markName }
    timeout {
      stop_spawn $target
      exit $timeoutExit
    }
    eof {
      catch {wait -i $target}
      exit $eofExit
    }
  }
}
proc expect_exact_or_exit {target value markName timeoutExit eofExit} {
  expect {
    -i $target
    -nocase -ex $value { mark $markName }
    timeout {
      stop_spawn $target
      exit $timeoutExit
    }
    eof {
      catch {wait -i $target}
      exit $eofExit
    }
  }
}
# The OpenShell TUI starts on Gateways. Refuse to navigate by position unless
# this ephemeral target owns exactly one sandbox.
if {[catch {exec openshell sandbox list --names} sandboxNames]} {
  puts "ISSUE6194_DIAGNOSTIC sandbox listing failed: $sandboxNames"
  exit 60
}
if {[string trim $sandboxNames] ne $sandbox} {
  puts "ISSUE6194_DIAGNOSTIC expected sole sandbox '$sandbox', got: $sandboxNames"
  exit 61
}
mark sole_sandbox_verified
# Do not clear unexpected rules: a pre-existing or concurrent pending request
# must fail this target instead of being hidden or accidentally approved.
if {[catch {exec openshell rule get $sandbox --status pending} pendingBefore]} {
  puts "ISSUE6194_DIAGNOSTIC pending-rule preflight failed: $pendingBefore"
  exit 62
}
set expectedEmpty "No network rules for sandbox '$sandbox'"
if {[string trim $pendingBefore] ne $expectedEmpty} {
  puts "ISSUE6194_DIAGNOSTIC pending-rule queue was not empty: $pendingBefore"
  exit 63
}
mark pending_queue_empty
# ShellProbe has no controlling TTY. Pin the terminal type and Expect-owned
# PTY geometry before OpenShell performs its first full-screen render.
set env(TERM) xterm-256color
spawn openshell term
set termSpawn $spawn_id
set termPty $spawn_out(slave,name)
stty rows 40 columns 120 < $termPty
set dashboardTimeout $timeout
set timeout ${ISSUE6194_OPENSHELL_DASHBOARD_TIMEOUT_SEC}
expect_exact_or_exit $termSpawn {Sandboxes} openshell_dashboard 64 65
set timeout $dashboardTimeout
# Gateways -> Providers -> Sandboxes.
send -i $termSpawn -- "\\t"
after 200
send -i $termSpawn -- "\\t"
after 200
expect_exact_or_exit $termSpawn $sandbox openshell_sandbox_listed 66 67
send -i $termSpawn -- "\\r"
# Ratatui renders the sandbox identity before the policy panel. Assert the
# exact sandbox first so waiting for the later heading cannot consume its
# earlier terminal diff and leave the identity check waiting forever.
expect_exact_or_exit $termSpawn $sandbox openshell_sandbox_detail_name 70 71
expect_exact_or_exit $termSpawn {Filesystem Access} openshell_sandbox_detail 68 69
# OpenShell documents 'r' as the Network Rules focus key in sandbox detail.
send -i $termSpawn -- "r"
expect_exact_or_exit $termSpawn {Network Rules} network_rules_focused 72 73
# The request uses argv boundaries and hard time limits. Its output belongs to
# a separate spawn, so it cannot satisfy any openshell term UI assertion.
spawn -noecho openshell sandbox exec --name $sandbox --no-tty --timeout 40 -- /usr/bin/curl -sS --connect-timeout 5 --max-time 30 -o /dev/null $networkEndpoint
set curlSpawn $spawn_id
mark network_request_triggered
set savedTimeout $timeout
set timeout 45
expect {
  -i $curlSpawn
  eof { set triggerOutput $expect_out(buffer) }
  timeout {
    stop_spawn $curlSpawn
    stop_spawn $termSpawn
    exit 74
  }
}
set timeout $savedTimeout
catch {wait -i $curlSpawn} curlWait
write_capture $triggerCapture $triggerOutput
mark network_request_completed
# Poll the supported rule CLI until it proves there is exactly one pending
# chunk and that it belongs to this exact curl/endpoint pair.
set pendingOutput ""
set pendingReady 0
for {set attempt 0} {$attempt < 20} {incr attempt} {
  set pendingGetFailed [catch {exec openshell rule get $sandbox --status pending} candidate]
  # OpenShell may color labels even when output is captured. Strip SGR before
  # parsing and publishing the rule evidence so label/value matches remain
  # deterministic across runner terminals and OpenShell render modes.
  regsub -all {\\x1b\\[[0-9;]*m} $candidate "" pendingOutput
  if {!$pendingGetFailed} {
    set chunkCount [regexp -all -line {^[[:space:]]*Chunk:} $pendingOutput]
    set oneChunk [regexp -nocase {Network Rules:[^\\r\\n]*1 chunk} $pendingOutput]
    set pendingStatus [regexp -nocase {Status:[[:space:]]*pending} $pendingOutput]
    set curlBinary [regexp {Binary:[[:space:]]*/usr/bin/curl} $pendingOutput]
    set expectedEndpoint [expr {[string first $networkHost $pendingOutput] >= 0}]
    if {$chunkCount == 1 && $oneChunk && $pendingStatus && $curlBinary && $expectedEndpoint} {
      set pendingReady 1
      break
    }
  }
  after 500
}
write_capture $ruleCapture $pendingOutput
if {!$pendingReady} {
  puts "ISSUE6194_DIAGNOSTIC expected one curl pending rule, got: $pendingOutput"
  stop_spawn $termSpawn
  exit 75
}
mark network_rule_singleton
# Only the OpenShell term spawn can satisfy these patterns. The trigger output
# and assistant transcript are isolated from this buffer.
expect_exact_or_exit $termSpawn $networkHost network_rule_endpoint 76 77
send -i $termSpawn -- "\\r"
expect_or_exit $termSpawn {Status:[^\\r\\n]*pending} network_rule_detail 78 79
expect_or_exit $termSpawn {Binary:[^\\r\\n]*/usr/bin/curl} network_rule_detail_binary 80 81
expect_exact_or_exit $termSpawn $networkHost network_rule_detail_endpoint 82 83
expect_or_exit $termSpawn {\\[a\\][^\\r\\n]*Approve} network_rule_approve_action 84 85
send -i $termSpawn -- "a"
expect {
  -i $termSpawn
  -nocase -re {Approved[^\\r\\n]*'[^']+'[^\\r\\n]*policy v([0-9]+)} {
    set approvedPolicyVersion $expect_out(1,string)
    mark network_approval_processed
  }
  timeout {
    stop_spawn $termSpawn
    exit 86
  }
  eof {
    catch {wait -i $termSpawn}
    exit 87
  }
}
# The approval RPC assigns a policy revision before the sandbox loads it.
# Poll that policy revision through the read-only policy API until both its
# status and the active version prove convergence. Preserve every bounded
# attempt so timeout and failed-revision diagnostics remain reviewable.
set policyStatusOutput "ISSUE6194_APPROVED_POLICY_VERSION=$approvedPolicyVersion\\n"
set policyLoaded 0
set policyTerminalStatus timeout
set policyLoadDeadline [expr {[clock milliseconds] + 60000}]
set attempt 0
while {[clock milliseconds] < $policyLoadDeadline} {
  incr attempt
  set policyGetFailed [catch {exec timeout 2 openshell policy get $sandbox --rev $approvedPolicyVersion --output json} candidate]
  append policyStatusOutput "ISSUE6194_POLICY_STATUS_ATTEMPT=$attempt\\n$candidate\\n"
  set versionPattern [format {"version"[[:space:]]*:[[:space:]]*%s([[:space:]]|,)} $approvedPolicyVersion]
  set activePattern [format {"active_version"[[:space:]]*:[[:space:]]*%s([[:space:]]|,)} $approvedPolicyVersion]
  set versionMatches [regexp $versionPattern $candidate]
  set statusLoaded [regexp {"status"[[:space:]]*:[[:space:]]*"loaded"} $candidate]
  set activeMatches [regexp $activePattern $candidate]
  if {!$policyGetFailed && $versionMatches && $statusLoaded && $activeMatches} {
    append policyStatusOutput "ISSUE6194_ACTIVE_POLICY_VERSION=$approvedPolicyVersion\\n"
    append policyStatusOutput "ISSUE6194_POLICY_STATUS=loaded\\n"
    set policyLoaded 1
    break
  }
  if {!$policyGetFailed && [regexp {"status"[[:space:]]*:[[:space:]]*"(failed|superseded)"} $candidate _ terminalStatus]} {
    set policyTerminalStatus $terminalStatus
    break
  }
  after 1000
}
if {!$policyLoaded} {
  append policyStatusOutput "ISSUE6194_POLICY_STATUS=$policyTerminalStatus\\n"
  write_capture $policyCapture $policyStatusOutput
  puts "ISSUE6194_DIAGNOSTIC approved policy revision did not become active: $policyStatusOutput"
  stop_spawn $termSpawn
  exit 90
}
mark network_policy_loaded
# Retry the exact documented Atlassian probe once the acknowledged policy
# revision is active. An unauthenticated 401 is the expected success signal.
spawn -noecho openshell sandbox exec --name $sandbox --no-tty --timeout 20 -- /usr/bin/curl -sS --connect-timeout 5 --max-time 10 -o /dev/null -w {ISSUE6194_POLICY_HTTP_STATUS=%{http_code}\\n} $networkEndpoint
set policySpawn $spawn_id
set policyOutput ""
set savedTimeout $timeout
set timeout 25
expect {
  -i $policySpawn
  eof { set policyOutput $expect_out(buffer) }
  timeout {
    write_capture $policyCapture $policyStatusOutput
    stop_spawn $policySpawn
    stop_spawn $termSpawn
    exit 88
  }
}
set timeout $savedTimeout
catch {wait -i $policySpawn} policyWait
write_capture $policyCapture "$policyStatusOutput$policyOutput"
if {![regexp {ISSUE6194_POLICY_HTTP_STATUS=401(\\r?\\n|$)} $policyOutput]} {
  puts "ISSUE6194_DIAGNOSTIC approved policy did not permit the exact endpoint: $policyOutput"
  stop_spawn $termSpawn
  exit 91
}
mark network_policy_updated
send -i $termSpawn -- "q"
expect {
  -i $termSpawn
  eof {}
  timeout {
    send -i $termSpawn "\\003"
    expect {
      -i $termSpawn
      eof {}
      timeout {
        stop_spawn $termSpawn
        exit 89
      }
    }
  }
}
catch {wait -i $termSpawn} termWait
mark openshell_clean_exit
exit 0
`;
}
