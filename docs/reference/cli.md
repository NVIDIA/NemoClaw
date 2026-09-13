# CLI reference

NemoClaw has four top-level commands: `plan`, `apply`, `export`, and `destroy`.
Use [the lifecycle guide](../guides/lifecycle.md) for procedures and recovery.

| Command | Input | Result and effects |
| --- | --- | --- |
| `plan` | YAML from stdin or `--file` | JSON preview; observes resources without changing them |
| `apply` | YAML from stdin or `--file` | JSON result; creates a fresh checked plan, applies it, and checks readiness |
| `export` | Recorded deployment state | YAML built from complete observations; no inference-health requirement |
| `plan --destroy` | Recorded deployment state | JSON teardown preview; no runtime mutations |
| `destroy` | Recorded deployment state | Fresh checked teardown plan and JSON result; removes workloads and retains specified data |

`plan --destroy` is a flag combination, not a fifth command.
There are no `invoke` or `channels` commands.
Errors go to stderr and return a nonzero exit status.
Additional positional arguments are rejected.

## Flags

| Flag | Commands | Default and meaning |
| --- | --- | --- |
| `--state-dir DIR` | All | `.nemoclaw`, relative to the current directory; selects persistent deployment state |
| `--bundle DIR` | All | Parent of the executable's `bin` directory; selects the private bundle |
| `--file YAML` | `plan`, `apply` | Omitted: read stdin; otherwise read the named file |
| `--destroy` | `plan` | False; preview teardown instead of planning YAML |

Use `--file` for plan and apply on PowerShell.
Export, destroy, and destroy preview reject `--file` and do not consume YAML.
A public preview is not an approval artifact reused by apply or destroy; each operation makes a fresh checked plan.
Every operation uses the local deployment lock.
That lock does not exclude other gateway clients.
