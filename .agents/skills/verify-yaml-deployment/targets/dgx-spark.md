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

### Existing Endpoint (Default Here)

Reuse a vLLM that another deployment already runs on this host; the managed service would download about 75 GiB first.
Its container carries `org.nemoclaw.backend=vllm`; its published address is the endpoint, and its key sits in its `-auth` volume:

```sh
sudo docker ps --filter label=org.nemoclaw.backend=vllm --format '{{.Names}} {{.Ports}}'
VLLM=REPLACE_WITH_CONTAINER_NAME
ENDPOINT=http://REPLACE_WITH_PUBLISHED_ADDRESS/v1
KEY_FILE=$(sudo docker volume inspect "$VLLM-auth" --format '{{.Mountpoint}}')/inference-key
PROVIDER_KEY_ENV=VLLM_KEY
export VLLM_KEY=$(sudo cat "$KEY_FILE")
MODEL=$(curl -s -m 10 -H "Authorization: Bearer $VLLM_KEY" "$ENDPOINT/models" | jq -r '.data[0].id')
echo "$ENDPOINT $MODEL" > "$EVIDENCE/inference.txt"
```

Stop if no vLLM runs or `MODEL` is empty: the precondition is missing.
That server, its network, and its key belong to another deployment: read them, never change them.
Edit the YAML: delete `spec.services`, and replace `spec.inferenceProviders` and the route's model:

```sh
python3 - "$RUN_DIR/deployment.yaml" "$ENDPOINT" "$MODEL" <<'PY'
import sys, yaml
path, endpoint, model = sys.argv[1:]
doc = yaml.safe_load(open(path))
doc["spec"].pop("services", None)
doc["spec"]["inferenceProviders"] = {"vllm": {
    "provider": "openai", "api": "openai-completions",
    "endpoint": endpoint, "credential": {"env": "VLLM_KEY"}}}
route = doc["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]
route["providerRef"] = "vllm"
route["overrides"]["model"] = model
yaml.safe_dump(doc, open(path, "w"), sort_keys=False)
PY
```

The snippet uses PyYAML, which this host has; it drops the file's comments.

### Managed Service

Keep the example's `services.super` and set its `image` to a `docker buildx bake vllm` digest, as the GTC DC README shows.
The first apply downloads about 75 GiB and loads for about 15 minutes; it also creates model storage that destroy retains.
Ask the user first, and check that the host has the memory the README lists, with no other model running.

## Gotchas

- The examples' ports and subnets collide with earlier runs of those examples on the same host; always choose new ones.
- A shared vLLM serves one sequence at a time in the examples' settings; another deployment's request can slow a reply.
- `sudo grep` is needed to scan state written by the `docker` group.
