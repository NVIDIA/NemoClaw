<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Target: DGX Spark

An ARM64 GB10 host with shared host and GPU memory, running Docker with NVIDIA GPU access.
The [GTC DC README](../../../../examples/gtc-dc/README.md) owns its prerequisites and memory accounting.

## Examples

| Agent | Example |
|---|---|
| `openclaw` | [`examples/gtc-dc/openclaw-dgx-spark.yaml`](../../../../examples/gtc-dc/openclaw-dgx-spark.yaml) |
| `hermes` | [`examples/gtc-dc/hermes-dgx-spark.yaml`](../../../../examples/gtc-dc/hermes-dgx-spark.yaml) |
| `deepagents` | [`examples/gtc-dc/deepagents-dgx-spark.yaml`](../../../../examples/gtc-dc/deepagents-dgx-spark.yaml) |

```sh
EXAMPLE=examples/gtc-dc/$AGENT-dgx-spark.yaml
```

Each declares a managed vLLM service, `super`, serving Nemotron 3 Super NVFP4.

## Docker Access

Check whether the user can reach Docker directly:

```sh
docker ps -q > /dev/null && echo direct || echo sudo
```

With `direct`, use the skill's commands as written.
With `sudo`, prefix each `docker` command with `sudo`, build images with `sudo -u "$USER" -g docker env PATH="$PATH" HOME="$HOME" cargo images build …`, and define `nc` to run the CLI with the `docker` group and the provider credential:

```sh
nc() {
  case "$1" in plan|apply) set -- "$@" --non-interactive ;; esac
  sudo --preserve-env="$PROVIDER_KEY_ENV" -u "$USER" -g docker "$BUNDLE/bin/nemoclaw" "$@" --state-dir "$STATE"
}
```

Without `--preserve-env`, sudo drops the credential and plan reports it unavailable.

## Inference Sources

### Discover Running and Retained Inference First

Before proposing a new model download, inspect running and stopped containers, then retained model and credential volumes on this host:

```sh
docker ps -a --filter label=org.nemoclaw.backend=vllm --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
docker volume ls --format '{{.Name}}' | grep -E 'inference-.*-(data|auth)$'
```

The unfiltered container list also finds externally operated servers without NemoClaw labels.
Names alone do not establish the model: a retained vLLM container may serve something other than Nemotron.
For a candidate, inspect its image, mounts, published ports, restart policy and ownership labels; do not dump its environment or credential-bearing arguments.
Match it to its original deployment YAML, state directory and bundle in the known run directories.

If only volumes remain, inspect the selected data volume read-only with an existing local utility image and `--mount type=volume,src=VOLUME,dst=/data,readonly`.
Check `/data/status.json` and `/data/models/*/.nemoclaw-manifest.json` for the stop reason, model repository and exact revision.
Check that manifest files and the shards named by `model.safetensors.index.json` exist with the recorded sizes.
Record the checks performed: presence and size checks do not prove hashes or inference readiness.
Never print the auth volume's key, relabel retained volumes, or attach them to a fresh test UID as an adoption shortcut.

| Observed state | Next action |
|---|---|
| Matching server is running | Verify its authenticated `/models` response, then use Existing Endpoint below |
| Matching container is stopped | Establish the stop reason and available memory; resume only with authorization and its owner's supported lifecycle procedure |
| Compute was destroyed but matching cache, credentials, YAML, state and bundle remain | Follow [deployment recovery](../../../../docs/build-deploy/usage.md#updates-and-recovery) with the original identity and bundle; preview the whole plan before apply, since it may recreate an agent and gateway as well as inference |
| Cache exists but recovery inputs are missing | Report retained data separately from a recoverable deployment; there is no lost-state adoption workflow for credentials or gateway storage |
| No matching server or reusable cache is established | Ask which inference source to provision before downloading a model |

For managed vLLM, follow [stopped-runtime diagnosis](../../../../docs/agents-inference/models.md#diagnose-and-recover-a-stopped-runtime).
A retained `ready` status is historical; recheck current health and authenticated model identity after recovery.
Do not blindly restart after memory protection or enable an automatic restart loop that defeats it.

For repeated runs, keep the inference owner's YAML, bundle and state separate from each disposable agent deployment, and consume its endpoint below.
Test cleanup must leave that external service and its storage untouched.
Treat a service labeled `org.nemoclaw.lifecycle=persistent` or `org.nemoclaw.test-cleanup=preserve` as externally owned: record its endpoint and reuse it after readiness checks; never stop, destroy, or prune its container, network, image, or volumes during test cleanup.
Resolve its credential volume from the container's `/credentials` mount rather than assuming a volume name.
Keeping it available requires an operator-owned lifecycle; it does not follow from retaining model weights.
The current YAML schema requires at least one sandbox, so removing every sandbox from an old YAML is not a supported model-only deployment.
Establish that persistent deployment separately before running this verification skill.

### Existing Endpoint (Default Here)

Reuse a verified vLLM endpoint on this host; provisioning with an empty cache requires about 75 GiB of model downloads.
Select the verified container from discovery above. Use its published address as the endpoint and resolve its credential volume from the `/credentials` mount:

```sh
sudo docker ps --filter label=org.nemoclaw.backend=vllm --format '{{.Names}} {{.Ports}}'
VLLM=REPLACE_WITH_CONTAINER_NAME
ENDPOINT=http://REPLACE_WITH_PUBLISHED_ADDRESS/v1
AUTH_VOLUME=$(sudo docker inspect "$VLLM" --format '{{json .Mounts}}' | jq -er '[.[] | select(.Type == "volume" and .Destination == "/credentials") | .Name] | if length == 1 then .[0] else error("expected one credential volume") end')
KEY_FILE=$(sudo docker volume inspect "$AUTH_VOLUME" --format '{{.Mountpoint}}')/inference-key
PROVIDER_KEY_ENV=VLLM_KEY
export VLLM_KEY=$(sudo cat "$KEY_FILE")
MODEL=$(curl -fsS -m 10 -H "Authorization: Bearer $VLLM_KEY" "$ENDPOINT/models" | jq -er '.data[0].id | select(type == "string" and length > 0)')
test -n "$MODEL" || { echo 'No verified model identity; stop before deployment.' >&2; exit 1; }
echo "$ENDPOINT $MODEL" > "$EVIDENCE/inference.txt"
```

If no vLLM runs, follow the retained-inference discovery above before declaring the precondition missing or proposing a download.
If `MODEL` is empty, diagnose readiness or authentication; do not proceed with an unverified endpoint.
That server, its network, and its key belong to another deployment: read them, never change them.
Edit the YAML by hand, writing out the values of `$ENDPOINT` and `$MODEL`:

1. Delete the whole `spec.services` block.
2. Replace `spec.inferenceProviders` with:
   ```yaml
     inferenceProviders:
       vllm:
         provider: openai
         api: openai-completions
         endpoint: REPLACE_WITH_ENDPOINT
         credential:
           env: VLLM_KEY
   ```
3. In the sandbox's route, set `providerRef: vllm` and `overrides.model: REPLACE_WITH_MODEL`.

Then check the edits:

```sh
grep -c '^  services:' "$RUN_DIR/deployment.yaml"
grep -cE "endpoint: $ENDPOINT\$|providerRef: vllm\$|model: $MODEL\$" "$RUN_DIR/deployment.yaml"
```

Result: `0`, then `3`.

### Managed Service

Keep the example's `services.super` and set its `image` to a `docker buildx bake vllm` digest, as the GTC DC README shows.
The first apply downloads about 75 GiB and loads for about 15 minutes; it also creates model storage that destroy retains.
Ask the user first, and check that the host has the memory the README lists, with no other model running.

## Gotchas

- The examples' ports and subnets collide with earlier runs of those examples on the same host; always choose new ones.
- A shared vLLM serves one sequence at a time in the examples' settings; another deployment's request can slow a reply.
