# OSMO CLI Command Reference

Complete reference for all `osmo` subcommands and their flags.

## Table of Contents

- [`osmo login` / `osmo logout`](#osmo-login--osmo-logout)
- [`osmo workflow`](#osmo-workflow)
- [`osmo pool`](#osmo-pool)
- [`osmo resource`](#osmo-resource)
- [`osmo dataset`](#osmo-dataset)
- [`osmo data` (Direct Storage)](#osmo-data-direct-storage)
- [`osmo app`](#osmo-app)
- [`osmo profile`](#osmo-profile)
- [`osmo user` (Admin)](#osmo-user-admin)
- [`osmo token` (Personal Access Tokens)](#osmo-token-personal-access-tokens)
- [`osmo credential`](#osmo-credential)
- [`osmo bucket`](#osmo-bucket)
- [`osmo task`](#osmo-task)
- [Configs (Admin)](#configs-admin)
- [`osmo standalone` (Local Docker Execution)](#osmo-standalone-local-docker-execution)
- [`osmo docker-compose` (Local Parallel Execution)](#osmo-docker-compose-local-parallel-execution)
- [Global Flags](#global-flags)

---

## `osmo login` / `osmo logout`

```bash
osmo login <url> [--method code|password|token|dev]

# Device code flow (default) — opens browser
osmo login https://osmo.example.com

# Password flow
osmo login https://osmo.example.com --method password --username user --password pass
osmo login https://osmo.example.com --method password --username user --password-file /path

# Refresh token flow
osmo login https://osmo.example.com --method token --token <refresh_token>
osmo login https://osmo.example.com --method token --token-file /path

# Dev mode (no JWT, header-only auth)
osmo login https://osmo.example.com --method dev --username devuser

osmo logout   # clears stored credentials from login.yaml
```

Additional flags: `--device-endpoint <url>` (override device flow endpoint).

---

## `osmo workflow`

### `submit`

```bash
osmo workflow submit <file_or_workflow_id> [flags]
```

| Flag | Description |
|------|-------------|
| `--pool` / `-p` | Target pool (required unless default set) |
| `--set key=value [k2=v2]` | Override Jinja template variables (auto-casts numbers) |
| `--set-string key=value` | Override as string (no type casting) |
| `--set-env key=ENV_VAR` | Set variable from environment variable |
| `--dry-run` | Validate and expand templates without submitting |
| `--priority HIGH\|NORMAL\|LOW` | Workflow priority |
| `--rsync local:remote` | Rsync local path into task |
| `--format-type json\|text` | Output format |

If the first argument is not a file path, it's treated as a workflow ID for resubmission
(in that case `--dry-run`, `--set` are not allowed).

### `validate`

```bash
osmo workflow validate <file.yaml> --pool <pool> [--set key=val]
```

Server-side validation only (no submission).

### `restart`

```bash
osmo workflow restart <workflow_id> [--pool <pool>] [--format-type json|text]
```

### `list`

```bash
osmo workflow list [flags]
```

| Flag | Description |
|------|-------------|
| `--count` / `-c` | Results per page (default 20) |
| `--offset` / `-f` | Pagination offset |
| `--name` / `-n` | Filter by name |
| `--status` | Filter: PENDING, SCHEDULING, RUNNING, COMPLETED, FAILED, CANCELED, etc. |
| `--pool` / `-p` | Filter by pool(s) |
| `--user` / `-u` | Filter by user |
| `--all-users` / `-a` | Show all users (mutually exclusive with `--user`) |
| `--order` / `-o` | `asc` or `desc` |
| `--submitted-after` | Date filter (YYYY-MM-DD) |
| `--submitted-before` | Date filter (YYYY-MM-DD) |
| `--tags` | Filter by admin tags |
| `--priority` | Filter by priority |
| `--app` / `-P` | Filter by app name or `app:version` |
| `--format-type` / `-t` | `json` or `text` |

### `query`

```bash
osmo workflow query <workflow_id> [--verbose] [--format-type json|text]
```

Returns detailed status, task states, Grafana URL, K8s dashboard link.

### `logs`

```bash
osmo workflow logs <workflow_id> [--task <name>] [--retry-id <n>] [--error] [-n <lines>]
```

Streams logs. Use `--task` to filter to a specific task. `-n` limits to last N lines.

### `events`

```bash
osmo workflow events <workflow_id> [--task <name>] [--retry-id <n>]
```

Streams Kubernetes events. Useful for debugging PENDING workflows.

### `cancel`

```bash
osmo workflow cancel <id> [<id2>...] [--message "reason"] [--force]
```

### `exec`

```bash
osmo workflow exec <workflow_id> <task_name> [--entry /bin/bash] [--keep-alive]
osmo workflow exec <workflow_id> --group <group> [--entry <cmd>]
```

Opens interactive shell into a running task or group.

### `spec`

```bash
osmo workflow spec <workflow_id> [--template]
```

`--template` returns the original YAML with template variables unexpanded.

### `port-forward`

```bash
osmo workflow port-forward <workflow_id> <task> --port <local>:<remote> [--host localhost] [--udp]
```

### `rsync`

```bash
osmo workflow rsync upload <workflow_id> [<task>] <local_path>:<remote_path> [--daemon]
osmo workflow rsync download <workflow_id> [<task>] <remote_path>:<local_path>
osmo workflow rsync status <workflow_id> [<task>]
osmo workflow rsync stop <workflow_id> [<task>]
```

### `tag`

```bash
osmo workflow tag --workflow <id> --add <tag>
osmo workflow tag --workflow <id> --remove <tag>
osmo workflow tag   # list all admin tags
```

---

## `osmo pool`

```bash
osmo pool list [--pool <name>...] [--mode used|free] [--format-type json|text]
```

Shows GPU quota and capacity per pool. `--mode free` shows available instead of used.

---

## `osmo resource`

```bash
osmo resource list [--pool <name>...] [--platform <name>...] [--all] [--mode used|free]
osmo resource info <node_name> [--pool <name> --platform <name>]
```

`info` requires both `--pool` and `--platform` together, or neither.

---

## `osmo dataset`

### Core operations

```bash
osmo dataset upload <bucket/name:tag> <local_path> [--desc "..."] [--metadata m.yaml] [--labels l.yaml]
osmo dataset download <name:tag> <local_path> [--regex '.*\.png$'] [--resume]
osmo dataset delete <name:tag> [--force]
osmo dataset info <name> [--all] [--count N] [--order asc|desc]
osmo dataset list [--bucket <b>] [--name <n>] [--count N]
osmo dataset inspect <name:tag> [--format-type text|tree|json] [--regex ...] [--count N]
```

### Advanced

```bash
osmo dataset update <name:tag> --add <local_path>:<remote_path> [--remove 'regex']
osmo dataset collect <collection_name> <ds1> <ds2:tag> ...
osmo dataset rename <old> <new> [--force]
osmo dataset query <query.yaml> [--bucket <b>]
osmo dataset migrate <name:tag> --target-bucket <b>
osmo dataset tag <name:tag> --set <new_tag>   # or --delete
osmo dataset label <name:tag> --set key=val   # or --delete key
osmo dataset metadata <name:tag> --set key=val
osmo dataset checksum <local_path>             # local MD5 aggregate
osmo dataset check <name> [--access-type ...]
```

Dataset names follow the pattern `[bucket/]name[:tag]`.

---

## `osmo data` (Direct Storage)

```bash
osmo data upload <remote_uri> <local_path> [<more_paths>...] [--regex '...'] [-p N] [-T N]
osmo data download <remote_uri> <local_path> [--regex '...'] [--resume] [-p N] [-T N]
osmo data list <remote_uri> [--prefix <p>] [--recursive] [--regex '...'] [--no-pager]
osmo data delete <remote_uri> [--regex '...']
osmo data check <remote_uri> [--access-type <type>] [--config-file <path>]
```

`-p` sets parallel processes, `-T` sets threads per process. Uses the multi-cloud
storage SDK (S3, Azure, GCS, Swift, TOS).

For workflow outputs, use `osmo data`, including local MicroK8s MinIO. Do not
read `/var/snap/microk8s/common/default-storage/minio-operator-data*/` directly:
MinIO chunks objects and encrypts them at rest, so the files are not usable
outside MinIO. Use `--no-pager` whenever running non-interactively.

```bash
# Discover workflow folders
osmo data list --no-pager s3://osmo-workflows

# Inspect one workflow or output prefix
osmo data list --no-pager s3://osmo-workflows/<workflow_id>/
osmo data list --no-pager --recursive s3://osmo-workflows/<workflow_id>/

# Download so the files are available locally
osmo data download s3://osmo-workflows/<workflow_id>/ /tmp/<workflow_id>-data
```

Local MinIO client access is also valid when it goes through MinIO. The local
`mc` client may already have an `osmo` alias configured:

```bash
mc ls osmo/osmo-workflows/
mc ls --recursive osmo/osmo-workflows/<workflow_id>/
mc cp --recursive osmo/osmo-workflows/<workflow_id>/ /tmp/<workflow_id>-data/
```

Do not confuse this with direct disk access under `/var/snap/...`; that path is
chunked/encrypted and not usable as workflow output files.

---

## `osmo app`

```bash
osmo app create <name> --description "desc" [--file <yaml>]   # editor if no --file
osmo app update <name[:version]> [--file <yaml>]
osmo app info <name[:version]> [--count N] [--order asc|desc]
osmo app show <name[:version]>
osmo app spec <name[:version]>
osmo app list [--name <n>] [--user <u>] [--all-users] [--count N]
osmo app delete <name[:version]> [--all] [--force]
osmo app rename <old> <new> [--force]
osmo app submit <name[:version]> --pool <pool> [--set key=val] [--dry-run] [--priority ...]
```

`app submit` delegates to workflow submission with app context.

---

## `osmo profile`

```bash
osmo profile list                       # show profile, pools, settings
osmo profile set pool <pool_name>       # set default pool
osmo profile set bucket <bucket_name>   # set default bucket
osmo profile set notifications <bool>   # toggle notifications
```

---

## `osmo user` (Admin)

```bash
osmo user list [--format-type json|text]
osmo user create <username>
osmo user update <username> [role flags]
osmo user delete <username>
osmo user get <username>
```

---

## `osmo token` (Personal Access Tokens)

```bash
osmo token set <name> [--expires-at <date>] [--description "..."] [--roles ...]
osmo token delete <name>
osmo token list
osmo token roles <name>
```

Admin variants accept `--user <username>` to manage other users' tokens.

---

## `osmo credential`

```bash
osmo credential set <name> --type REGISTRY|DATA|GENERIC --payload key=value [k2=v2 ...]
osmo credential list
osmo credential delete <name>
```

**The CLI takes `--payload key=value` pairs, NOT `--server/--username/--password`
flags.** Those flags do not exist; using them will fail. See the full narrative
(NGC key resolution, workflow wiring, common gotchas) in `SKILL.md` →
**Set Up an Image Registry Credential**.

### `--type REGISTRY`

Used for pulling private container images in OSMO workflows. Keys:

| Key | Meaning |
|-----|---------|
| `registry` | Registry hostname (e.g. `nvcr.io`), no scheme, no path |
| `username` | Registry username (for NGC: literal `$oauthtoken`) |
| `auth` | **Raw** auth token (for NGC: the raw NGC API key). NOT the base64 `user:pass` string Docker writes to `~/.docker/config.json` |

```bash
# nvcr.io (NGC) — most common case
osmo credential set nvcr --type REGISTRY \
  --payload registry=nvcr.io username='$oauthtoken' auth="$NGC_API_KEY"
```

Reference it from a workflow task via the task-level `credentials:` map
(key = this credential name). OSMO auto-wires a REGISTRY credential referenced
this way as an `imagePullSecret` on the task pod. Example:

```yaml
tasks:
- name: train
  image: nvcr.io/nvidia/pytorch:24.01-py3
  credentials:
    nvcr:                          # same name used with `osmo credential set`
      NGC_CLI_API_KEY: auth        # optional: also expose `auth` as an env var
```

Name must match exactly — `nvcr_io` ≠ `nvcr-io`. Mismatches show up as
`ImagePullBackOff` on the task pod. See `references/workflow-spec.md` for the
full `credentials:` schema.

### `--type GENERIC`

Arbitrary key-value secrets surfaced into tasks (env vars or credential mount).
Commonly used for HuggingFace tokens, API keys, etc. Keys are free-form — the
task spec decides how to consume them.

```bash
osmo credential set hf-token --type GENERIC --payload token=hf_YOUR_TOKEN
osmo credential set ngc-api-key --type GENERIC --payload key="$NGC_API_KEY"
```

### `--type DATA`

Object-storage credentials for `osmo dataset` / `osmo data` and workflow
`inputs:` / `outputs:` that point at S3/GCS/Azure/Swift/TOS URIs. Also updates
the local `config.yaml` so the storage SDK picks it up for subsequent
client-side calls.

```bash
osmo credential set my-s3 --type DATA --payload \
  access_key=AKIA... secret_key=... endpoint=https://s3.amazonaws.com region=us-east-1
```

Exact keys vary by provider; see `osmo credential set --help` and
`references/workflow-spec.md` for the provider-specific fields. For non-AWS S3
(MinIO, TOS, etc.), both `region` and `override_url`/`endpoint` are typically
required.

---

## `osmo bucket`

```bash
osmo bucket list
```

---

## `osmo task`

```bash
osmo task list [--workflow <id>] [--status ...] [--pool ...] [--count N]
```

---

## Configs (Admin)

In 6.3 ConfigMap mode (`services.configFile.enabled: true`), all configs live in the `osmo-service-configs` ConfigMap. The `osmo config` CLI subcommands no-op or 409 here.

```bash
# Read
kubectl get cm osmo-service-configs -n osmo-minimal -o yaml

# Apply a change (scripted, idempotent)
kubectl patch cm osmo-service-configs -n osmo-minimal --type=merge -p ...
```

The osmo-service container watches `/etc/osmo/configs/config.yaml` via inotify and reloads on change.


---

## `osmo standalone` (Local Docker Execution)

```bash
osmo standalone run -f <workflow.yaml> [flags]
```

| Flag | Description |
|------|-------------|
| `-f` / `--file` | Workflow YAML (required) |
| `--work-dir` | Working directory for intermediate data |
| `--keep` | Preserve containers after completion |
| `--docker` | Docker binary path (default: `docker`) |
| `--resume` | Resume from last successful step |
| `--from-step <task>` | Resume from a specific task |
| `--credential NAME=PATH` | Mount credential directory (repeatable) |
| `--set key=value` | Template variable overrides |
| `--set-string key=value` | String-only overrides |
| `--shm-size <size>` | Shared memory size (e.g. `16g`) |

Runs tasks serially via `docker run`. Does NOT support `{{host:taskname}}` —
use `docker-compose` for inter-task networking.

---

## `osmo docker-compose` (Local Parallel Execution)

```bash
osmo docker-compose run -f <workflow.yaml> [flags]
```

Same flags as `standalone` except `--compose-cmd` replaces `--docker`:

| Flag | Description |
|------|-------------|
| `--compose-cmd` | Compose command (default: `docker compose`) |

Supports `{{host:taskname}}` via shared Docker networks. Tasks in the same
group run in parallel. Groups execute in topological order (serial between groups,
parallel within).

---

## Global Flags

All commands support:

| Flag | Description |
|------|-------------|
| `--log-level` | Logging level (default: INFO) |

Most list/query commands support:

| Flag | Description |
|------|-------------|
| `--format-type` / `-t` | `json` or `text` (default: text) |

Use `--format-type json` for machine-readable output (recommended for scripting
and when parsing output programmatically).
