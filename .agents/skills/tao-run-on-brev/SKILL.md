---
name: tao-run-on-brev
description: Brev managed GPU instances with Docker support. Use when running TAO training, evaluation, or inference on
  Brev GPU instances, managing Brev deployments, or dispatching TAO jobs through the Brev CLI. Trigger phrases include
  "run on Brev", "Brev GPU instance", "submit job to Brev", "Brev CLI deployment".
license: Apache-2.0
compatibility: Requires the brev CLI (https://github.com/brevdev/brev-cli) and an active brev login.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- gpu
- compute
- instance-based
- brev
---

# Brev

NVIDIA Brev provides on-demand GPU instances across multiple cloud providers. Instances come pre-loaded with NVIDIA drivers, CUDA, Docker, and NVIDIA Container Toolkit.

Brev is instance-based (not job-based like Lepton). You create an instance, run commands on it via `brev exec`, and delete it when done. The TAO SDK's BrevHandler wraps this into the standard job interface.

## Preflight

This skill needs the `brev` CLI, its companion agent skill (`brev-cli`), and an active login. Check before proceeding:

```bash
# 1. brev CLI installed
command -v brev >/dev/null 2>&1 || {
  echo "MISSING: brev CLI not installed. Install:"
  echo "  https://docs.nvidia.com/brev/"
  exit 1
}

# 2. brev-cli agent skill installed — provides the brev CLI's command reference to the agent
[ -d "$HOME/.claude/skills/brev-cli" ] || [ -d ".claude/skills/brev-cli" ] || {
  echo "MISSING: brev-cli agent skill not installed. Run:"
  echo "  brev agent-skill install"
  exit 1
}

# 3. brev login active — always token-login first when running headless.
#    Plain `brev ls` will hit an interactive auth prompt (read: EOF on stdin)
#    even when BREV_API_TOKEN is set, so refresh the session up front.
if [ -n "$BREV_API_TOKEN" ]; then
  brev login --token "$BREV_API_TOKEN" >/dev/null 2>&1 || {
    echo "MISSING: brev token login failed. Verify BREV_API_TOKEN."
    exit 1
  }
fi
# Retry once after a forced re-login: cached creds occasionally desync and the
# first `brev ls` returns auth EOF until the session is rebuilt.
brev ls >/dev/null 2>&1 || {
  [ -n "$BREV_API_TOKEN" ] && brev login --token "$BREV_API_TOKEN" >/dev/null 2>&1
  brev ls >/dev/null 2>&1 || {
    echo "MISSING: not logged in to brev. Run:"
    echo "  brev login                                    # interactive (opens browser)"
    echo "  # or set BREV_API_TOKEN in ~/.config/tao/.env (then 'brev login --token \$BREV_API_TOKEN')"
    exit 1
  }
}
```

If any step fails, the agent prompts the user to authorize the fix via Bash, then re-runs the preflight before continuing. The TAO SDK is **not** required for Brev — `brev exec docker run …` is sufficient. Reach for the SDK only if you want Job handles, S3 I/O wrapping via `script_runner`, or state persistence; `nvidia-tao-sdk` is on public PyPI, install the pinned Brev extra from `versions.yaml`: `pip install "$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_sdk_brev)"`. **When going the SDK route, read `tao-skill-bank:tao-run-platform` for the `BrevSDK` kwarg reference, `build_entrypoint`, and `ActionWorkflow` patterns.**

## Authentication

Two options:

1. **Automated (recommended)**: Get an API token from the Brev console settings page. Set `BREV_API_TOKEN` as an environment variable (e.g., in `~/.config/tao/.env`). The handler auto-authenticates via `brev login --token` on first use — same UX as Lepton.

2. **Manual**: Run `brev login` (opens browser). Tokens expire hourly — the handler refreshes automatically.

S3 credentials (ACCESS_KEY, SECRET_KEY) are needed separately for data transfer.

### Headless / non-interactive

In a CI shell, container, or agent session with no controlling TTY, **always
run `brev login --token "$BREV_API_TOKEN"` before any other `brev` call** —
even when the token is exported. Otherwise the CLI prompts on stdin and
returns an `EOF` auth error on commands like `brev ls`, `brev create`, or
`brev exec`. Re-run the token login if a call returns auth-EOF; a single
refresh is usually enough.

## Launch Preflight

Before generating scripts or submitting jobs:

1. Verify `BREV_API_TOKEN` is set.
2. Verify the `brev` CLI is installed and can list instances, for example
   `brev ls --json`. If needed, authenticate with `brev login --token`.
3. For `s3://` datasets/results, verify `ACCESS_KEY` and `SECRET_KEY` are set
   and the exact paths are readable with `aws s3 ls`.
4. Do not accept local `/path` inputs for Brev unless the user has proven those
   paths exist on the target Brev instance or are mounted into it.
5. Verify model-specific credentials such as `HF_TOKEN` before launch.

## Instance Lifecycle

The agent controls instance lifecycle:

- **Reuse**: Pass `instance_id` in `backend_details` to run multiple jobs on the same instance. Efficient for multi-step workflows.
- **Ephemeral**: Omit `instance_id` — the handler creates a new instance per job. Clean but slower (instance boot ~2-5 min).

### Creating an instance — placement info

For accounts with more than one cloud credential or workspace group, plain
`brev create` rejects the call with a placement error. Pass the account-specific
IDs explicitly:

```bash
brev create my-instance \
  --gpu L40S:1 \
  --cloud-cred-id <cloudCredId> \
  --workspace-group-id <workspaceGroupId>
```

Discover the values once and stash them in `~/.config/tao/.env`:

```bash
brev ls --json | jq -r '.workspaces[0].workspaceGroupId'   # default group
brev orgs --json | jq -r '.[0].cloudCredentials[].id'      # cloud credential
```

When using the SDK, pass them through `backend_details`:

```python
BrevSDK().create_job(
    ...,
    backend_details={
        "cloud_cred_id": "<cloudCredId>",
        "workspace_group_id": "<workspaceGroupId>",
    },
)
```

## Multi-GPU and multi-node

**Multi-node is not supported on Brev.** Brev is instance-based — one job runs on one instance, with no cross-instance coordination.

Multi-GPU **on a single instance** is supported (instances available with up to 8× H100 / A100 / L40S). `gpu_count` maps to the GPU count on the instance; `torchrun --nproc-per-node=N` or PyTorch DDP work within the instance.

## GPU Types

Available via `brev search`:
- L40S, A100 80GB, H100 (availability varies by provider)
- Use `--gpu-name` to filter, `--min-vram` for memory requirements

## Storage

No shared NFS/Lustre. All data flows through S3 via the script_runner's fsspec integration. Instance-local disk under the login user's home directory (`$HOME`) persists across stop/start but not across delete/create.

## Docker on Brev

VM Mode instances have Docker pre-installed. For TAO container images:

```bash
# NGC auth (one-time per instance)
brev exec <instance> -- docker login nvcr.io -u '$oauthtoken' -p <NGC_KEY>

# Run a TAO training job
brev exec <instance> -- docker run --gpus all --rm \
  -v $HOME/data:/data \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-pyt \
  visual_changenet train -e /data/spec.yaml
```

### Wait for instance readiness before the first `brev exec`

A freshly created instance reports `RUNNING` long before sshd, hostname
resolution, and the user shell are ready. The first `brev exec` against an
unsettled instance fails with `hostname not resolvable`,
`Connection refused`, or a silent timeout. Always poll until a trivial exec
succeeds before issuing real work:

```bash
# Wait up to 5 minutes for shell readiness — covers the SSH bring-up window.
for i in $(seq 1 60); do
  brev exec <instance> -- true >/dev/null 2>&1 && break
  sleep 5
done
brev exec <instance> -- true >/dev/null 2>&1 || {
  echo "instance <instance> never became exec-ready"; exit 1;
}
```

### `brev exec` timeout for cold-start workloads

`brev exec` inherits no default timeout, but anything that wraps it (the SDK
handler, CI step wrappers, `timeout` shell builtins) must allow time for both
the SSH bring-up window and the container pull on a fresh instance. Use
**≥ 600 s (10 min)** for the first exec on a new instance; the previous
60–120 s default truncates remote startup and surfaces as a spurious
`exec failed` even though the remote command is still progressing.

## Mixed-Platform Workflows

Brev can be mixed with Lepton in the same workflow. Per-stage platform assignment:

```json
{"skill": "vcn-gap-analysis", "action": "analyze", "platform": "brev"},
{"skill": "visual-changenet", "action": "train", "platform": "lepton"}
```

CPU stages (gap analysis, data merge) run cheaply on Brev. GPU stages (training) run on Lepton H100s.

## Cleanup

```bash
brev delete <instance>      # plain delete — no flags
```

The CLI does not accept `--yes` / `-y`; passing it errors with
`unknown flag: --yes`. `brev delete <instance>` is already non-interactive on
recent CLIs, so no confirmation flag is needed.

## Error Patterns

**brev CLI not found**: Install from https://docs.nvidia.com/brev/.

**`brev ls` returns auth EOF even with `BREV_API_TOKEN` set**: Headless shell
has no stdin for the interactive auth prompt. Run
`brev login --token "$BREV_API_TOKEN"` first, then retry. If the failure
persists across a single retry, the token itself is stale — mint a fresh one.

**Token expired**: Handler auto-refreshes via `brev login --token`. If
persistent, run `brev login` manually.

**`brev create` rejected with placement error (`cloudCredId` /
`workspaceGroupId` required)**: Multi-credential or multi-workspace accounts
must pass `--cloud-cred-id` and/or `--workspace-group-id`. See
*Creating an instance — placement info* above.

**`brev exec` fails with `hostname not resolvable` or `Connection refused`
right after create**: Instance reports `RUNNING` before sshd is up. Use the
readiness-wait loop in *Wait for instance readiness before the first `brev
exec`* before issuing the real command.

**SDK exec timeout / `exec failed` on a fresh instance**: The SDK's
`brev exec` wrapper timed out before remote startup finished. Raise the
timeout to ≥ 600 s for cold-start runs (see *`brev exec` timeout for
cold-start workloads*).

**`brev delete --yes`: `unknown flag: --yes`**: The CLI has no confirmation
flag. Use plain `brev delete <instance>`.

**Instance stuck in provisioning**: Some GPU types have limited availability. Try a different `--gpu-name` or provider.

**Docker pull fails on nvcr.io**: NGC_KEY not set or expired. Run `docker login nvcr.io` on the instance.
