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
| `nemoclaw apply FILE` | YAML path or `-` for stdin | JSON result; computes a checked plan and applies it |
| `nemoclaw export` | Retained state; no YAML | Observed YAML after configuration and ownership checks |
| `nemoclaw destroy` | Retained state; no YAML | JSON result; removes owned workloads under the retention rules |

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
| `--verbose`, `-v` | All commands | Report completed-step timings and outcomes on stderr |
| `--output FILE`, `-o FILE` | `export` | Write YAML to a file |
| `--output FORMAT`, `-o FORMAT` | `plan` | Select `text` (default) or `json` for the preview, including `--destroy` |
| `--non-interactive` | `plan`, `apply` | Resolve credential references from nonempty environment variables and fail instead of prompting when any remain unresolved |
| `--destroy` | `plan` | Preview destroy; cannot be combined with a YAML input |
| `--help`, `-h` | CLI and subcommands | Display help |
| `--version`, `-V` | CLI | Display the CLI version |

Global options can appear before or after the subcommand.
Plan and apply require an explicit input; use `-` to read stdin.
Export and destroy do not accept a YAML path.

## Output and Failure

Successful plan operations write text to stdout by default, including when redirected.
Use `nemoclaw plan -o json FILE` or `nemoclaw plan --destroy -o json` for the existing JSON result structure; scripts that parse plan output must select this format explicitly.
The text preview lists each resource's actions and address, any reported retained resources, and any deferred work.
Deferred work means the plan is incomplete, even when no resource changes are currently planned.
Apply and destroy write JSON to stdout.
Export writes YAML to stdout or the selected output file.
On Unix, SIGINT or SIGTERM cancels an active terminal prompt and reports `operation interrupted`.
Errors go to stderr with a nonzero exit status.
Help and version output are plain text.
A supported Fabric health failure writes JSON to stderr with `error: fabric_readiness`, the `health` observation, and `resourcesRetained: true`.
See [apply health](../usage.md#fabric-health-during-apply) for unsupported checks, image requirements, and recovery.

When stderr is a terminal, commands show deployment phases, OpenTofu resource operations, and elapsed waiting time.
Readiness waits report elapsed time every 10 seconds; resource updates follow OpenTofu's event stream.
Durations below one second use milliseconds; longer durations use seconds.
Resource durations use OpenTofu event timestamps when available, falling back to its whole-second elapsed field.
Docker image pulls also show download phases and per-layer byte counts when available.
A known, nonzero layer total enables a percentage; it is not a percentage for the entire image.
Download updates can be dropped if progress reporting is unavailable or slow; the command result still determines success.
Progress messages do not establish successful inference.
Redirected stderr contains errors only unless `--verbose` enables progress output.

With `--verbose`, completed bundle verification, OpenTofu commands, sandbox/runtime readiness, and the `fabric.health` request report a fixed operation label, outcome, and elapsed time on stderr.
For example, `bundle.verify succeeded 92ms` reports one bundle verification.
Timing events contain no configuration values, credentials, or error diagnostics; ordinary errors are reported separately.
Progress messages do not change the selected stdout format.

The [SDK result type](../../crates/nemoclaw-sdk/src/deployment/mod.rs) defines the JSON fields:

| Field | Meaning |
|---|---|
| `outcome` | `planned`, `succeeded`, or `destroyed` |
| `changes` | Resource addresses and planned/applied action lists; an empty list does not mean apply skipped readiness checks |
| `deferred` | Checks or changes deferred by planning; omitted when empty |
| `health` | Apply observations for the hosted Fabric runtime; includes explicit unsupported results; omitted for other operations |
| `retained` | Retained resource addresses reported by the operation; omitted when empty and not an inventory of every surviving file or external service |

Use [inference verification](../inference.md#verify-the-result) to interpret a successful result.
The CLI returns 0 on success, 1 on an operation or output failure, and 2 for argument-parser errors.
The exit status determines whether stdout is a successful result; do not treat an empty output stream as an empty plan.

An export observation failure does not replace an existing file selected by `--output`.
Shell redirection can truncate a file before the CLI runs; check success before using redirected output.
See [recovery](../usage.md#updates-and-recovery) for interrupted operations and preserved state.

## Earlier Commands

The current CLI does not expose `launch`, `status`, `doctor`, `backup-all`, `rebuild`, or `config export`.
Use [migration](../migration.md) to find current task owners and **TBD** workflows.
