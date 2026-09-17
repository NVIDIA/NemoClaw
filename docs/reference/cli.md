<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw CLI Reference

Use `nemoclaw` from a [verified native bundle](../build.md).
Run commands from the directory containing your deployment YAML, and select the same state directory for every operation.
The [CLI parser](../../crates/nemoclaw-cli/src/args.rs) defines the commands and options below; [process tests](../../crates/nemoclaw-cli/tests/commands.rs) cover execution behavior.

## Commands

| Syntax | Input | Result and effect |
|---|---|---|
| `nemoclaw plan FILE` | YAML path or `-` for stdin | JSON preview; observes resources without mutating runtime resources |
| `nemoclaw plan --destroy` | Retained state; no YAML | JSON preview of workload deletion and retention |
| `nemoclaw apply FILE` | YAML path or `-` for stdin | JSON result; computes a checked plan and applies it |
| `nemoclaw export` | Retained state; no YAML | Observed YAML after configuration and ownership checks |
| `nemoclaw destroy` | Retained state; no YAML | JSON result; removes owned workloads under the retention rules |

Apply can download models and check readiness; it does not request model or agent responses.
Destroy does not prompt for confirmation and deletes sandbox files and conversation history.
Read [deployment lifecycle](../usage.md) and preview deletion before destroying a deployment.

## Options

| Option | Scope | Meaning |
|---|---|---|
| `--state-dir DIR` | All commands | Deployment state directory; defaults to `.nemoclaw` relative to the working directory |
| `--bundle DIR` | All commands | Explicit verified bundle; defaults to the bundle containing the CLI |
| `--bundle-dir DIR` | All commands | Alias for `--bundle` |
| `--verbose`, `-v` | All commands | Report completed-step timings and outcomes on stderr |
| `--output FILE`, `-o FILE` | `export` | Write YAML to a file instead of stdout |
| `--destroy` | `plan` | Preview destroy; cannot be combined with a YAML input |
| `--help`, `-h` | CLI and subcommands | Display help |
| `--version`, `-V` | CLI | Display the CLI version |

Global options can appear before or after the subcommand.
Plan and apply require an explicit input; use `-` to read stdin.
Export and destroy do not accept a YAML path.

## Output and Failure

Successful plan, apply, and destroy operations write JSON to stdout.
Export writes YAML to stdout or the selected output file.
Errors go to stderr with a nonzero exit status.
Help and version output are plain text.
A supported Fabric health failure writes JSON to stderr with `error: fabric_readiness`, the `health` observation, and `resourcesRetained: true`.
See [apply health](../usage.md#fabric-health-during-apply) for unsupported checks, image requirements, and recovery.

With `--verbose`, completed bundle verification, OpenTofu commands, sandbox/runtime readiness, and the `fabric.health` request report a fixed operation label, outcome, and elapsed seconds on stderr.
For example, `bundle.verify succeeded 0.092s` reports one bundle verification.
Timing events contain no configuration values, credentials, or error diagnostics; ordinary errors are reported separately.
Stdout retains its JSON or YAML format.

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

The current CLI does not expose `onboard`, `launch`, `status`, `doctor`, `backup-all`, `rebuild`, or `config export`.
Use [migration](../migration.md) to find current task owners and **TBD** workflows.
