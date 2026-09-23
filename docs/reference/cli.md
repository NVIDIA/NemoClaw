<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw CLI Reference

Use `nemoclaw` from a [verified native bundle](../build.md).
Run commands from the directory containing your deployment YAML, and select the same state directory for every operation.
The [CLI parser](../../crates/nemoclaw-cli/src/args.rs) defines the commands and options below; [process tests](../../crates/nemoclaw-cli/tests/commands.rs) cover execution behavior.

## Commands

| Syntax | Input | Result and effect |
|---|---|---|
| `nemoclaw plan FILE` | YAML path or `-` for stdin | Text preview; observes resources without mutating runtime resources |
| `nemoclaw plan --destroy` | Retained state; no YAML | Text preview of workload deletion and retention |
| `nemoclaw apply FILE` | YAML path or `-` for stdin | Text result; computes a checked plan and applies it |
| `nemoclaw export` | Retained state; no YAML | Observed YAML after configuration and ownership checks |
| `nemoclaw destroy` | Retained state; no YAML | Text result; removes owned workloads under the retention rules |

Apply can download models and check readiness; it does not request model or agent responses.
Destroy does not prompt for confirmation and deletes sandbox files and conversation history.
Read [deployment lifecycle](../usage.md) and preview deletion before destroying a deployment.

Plan and apply derive credential requirements from the parsed document.
They use a matching nonempty environment variable first and prompt only for unresolved references.
Terminal prompts hide entered values.
When configuration is read from stdin, all credential references must already be satisfied by nonempty environment variables because stdin is occupied by the document stream.
The CLI retains collected values only in memory for the current operation and supplies them through the SDK secrets boundary.
Use `--non-interactive` with plan or apply to fail with the unresolved reference names instead of prompting.
Credential values are not written to desired state, output, diagnostics, or deployment state by this fulfillment step.

## Options

| Option | Scope | Meaning |
|---|---|---|
| `--state-dir DIR` | All commands | Deployment state directory for lifecycle commands; defaults to `.nemoclaw` |
| `--bundle DIR` | All commands | Explicit verified bundle for lifecycle commands; defaults to the bundle containing the CLI |
| `--verbose`, `-v` | All commands | Include internal resource addresses and completed-step timings |
| `--progress MODE` | All commands | `auto` (default) selects inline terminal progress or plain redirected output; `plain` disables animation; `off` suppresses progress |
| `--output FILE`, `-o FILE` | `export` | Write YAML to a file |
| `--output FORMAT`, `-o FORMAT` | `plan`, `apply`, `destroy` | Select `text` (default) or `json`, including destroy previews |
| `--non-interactive` | `plan`, `apply` | Resolve credential references from nonempty environment variables and fail instead of prompting when any remain unresolved |
| `--destroy` | `plan` | Preview destroy; cannot be combined with a YAML input |
| `--help`, `-h` | CLI and subcommands | Display help |
| `--version`, `-V` | CLI | Display the CLI version |

Global options can appear before or after the subcommand.
Plan and apply require an explicit input; use `-` to read stdin.
Export and destroy do not accept a YAML path.

## Output and Failure

Plan, apply, and destroy write text results to stdout unless `-o json` is selected.
Export continues to write YAML to stdout or its selected file.
Use explicit JSON output for scripts:

```sh
nemoclaw plan -o json --progress off --state-dir .local/deployment deployment.yaml
nemoclaw apply -o json --progress off --state-dir .local/deployment deployment.yaml
nemoclaw plan --destroy -o json --progress off --state-dir .local/deployment
```

Text plans identify resource actions, retained resources, and deferred work.
Friendly labels replace known internal addresses; verbose output includes those addresses, and unknown resources keep their native identity.
Normal output groups image bindings by action sequence; verbose output lists each binding.
Deferred work produces a prominent incomplete-plan result even when the known change list is empty.
A plan with deferred work returns 0 because the preview succeeded; scripts must also check `complete` before treating it as a complete plan.
An observation failure returns a nonzero exit code.

Apply summarizes actual changes and reported Fabric health.
Unsupported health remains unsupported; a successful operation does not establish working model or agent responses.
Destroy distinguishes removed resources from retained storage and warns that retaining the OpenShell workspace does not preserve sandbox files or conversations.
The retained list describes tracked resources, not every surviving host file or external service.
See [apply health](../usage.md#fabric-health-during-apply) and [retention](../state.md#deletion-and-retention).

Progress goes to stderr independently of the result format.
The default inline Ratatui display uses the normal terminal screen, preserving completed milestones in scrollback.
It uses a compact panel for active resource operations and elapsed time without taking keyboard input or entering fullscreen mode.
Interactive operation starts stay in the panel; completed milestones and errors remain in scrollback.
Interactive progress starts with a compact NVIDIA / NemoClaw wordmark.
Successful completion headings are green, including destroy; destructive actions and retention warnings remain amber, and failures use red.
Labels carry the same meaning without color.
A nonempty `NO_COLOR` disables styling while preserving inline progress.
Redirected streams and JSON/YAML results have no added styling; `--progress plain` also disables styling and the wordmark.
Plain output reports stage changes and throttled waiting updates without cursor movement; use `--progress plain` for a terminal transcript or accessibility.
Use `--progress off` to suppress progress while preserving results and errors.
Redirected stderr uses plain progress by default, so scripts requiring a quiet stream should explicitly select `off`.

Resource operations come from OpenTofu's machine-readable events.
Download progress shows bytes and a percentage only when a valid total is known; it is not overall deployment completion.
Elapsed time is a heartbeat, not evidence that the runtime advanced to another startup stage.
Model-loading details unavailable from the existing event stream remain generic readiness or infrastructure waits.
Default progress omits known implementation steps; unrecognized resources and errors remain visible.
Verbose output adds implementation steps, internal addresses, timings, and outcomes.
Progress is best-effort and never determines the operation's success.

The CLI preserves the [SDK result fields](../../crates/nemoclaw-sdk/src/deployment/mod.rs) and adds plan completeness for scripts:

| Field | Meaning |
|---|---|
| `outcome` | `planned`, `succeeded`, or `destroyed` |
| `complete` | Whether a planned result has no deferred work; inspect this alongside the exit code |
| `changes` | Resource addresses and planned/applied action lists; an empty list does not mean apply skipped readiness checks |
| `deferred` | Checks or changes deferred by planning; omitted when empty |
| `health` | Apply observations for the hosted Fabric runtime; includes explicit unsupported results; omitted for other operations |
| `retained` | Retained resource addresses reported by the operation; omitted when empty and not an inventory of every surviving file or external service |

Handled operation errors use the selected format: text on stderr, or one JSON result on stdout with `outcome: failed` or `outcome: interrupted`.
The failure object includes `operation`, `stateDirectory`, optional `input`, and `error.message`; Fabric failures include `error.health`.
When available, `remainingState` describes the known effects and `help` supplies a next step.
Diagnostics identify the operation, cause, and confirmed retention where available; they do not imply rollback or cleanup when resource state is unknown.
On Unix, SIGINT and SIGTERM cancel ongoing work, including credential prompts.
Interruption preserves the recorded recovery boundary; follow [recovery](../usage.md#updates-and-recovery) before retrying.

| Exit code | Meaning |
|---|---|
| 0 | Operation completed; a plan can still report deferred work |
| 1 | Operation or output failure |
| 2 | Argument-parser error |
| 130 | Operation interrupted |

Help, version output, and argument-parser diagnostics remain text.
An output-stream failure or forced process termination may prevent a complete JSON result.
Do not treat missing or partial output as an empty plan.
Use [inference verification](../inference.md#verify-the-result) to interpret successful apply results.

An export observation failure does not replace an existing file selected by `--output`.
Shell redirection can truncate a file before the CLI runs; check success before using redirected output.
See [recovery](../usage.md#updates-and-recovery) for interrupted operations and preserved state.

## Earlier Commands

The current CLI does not expose `launch`, `status`, `doctor`, `backup-all`, `rebuild`, or `config export`.
Use [migration](../migration.md) to find current task owners and **TBD** workflows.
