# OSMO Workflow Spec Reference

Complete schema for OSMO workflow YAML files.

## Table of Contents

- [Top-Level Structure](#top-level-structure)
- [Resources](#resources)
- [Task Spec (`TaskSpec`)](#task-spec-taskspec)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Groups](#groups)
- [Special Tokens](#special-tokens)
- [Jinja Templates](#jinja-templates)
- [Cookbook Examples](#cookbook-examples)

---

## Top-Level Structure

```yaml
version: 2              # optional; must be 2 if present (default)

workflow:
  name: <string>        # workflow name
  pool: <string>        # target pool (usually set via --pool flag instead)
  resources: ...        # named resource profiles
  tasks: [...]          # flat task list (mutually exclusive with groups)
  groups: [...]         # grouped tasks (mutually exclusive with tasks)
  timeout:
    exec_timeout: <duration>   # max execution time
    queue_timeout: <duration>  # max queue wait time

default-values:         # Jinja template defaults (top-level, outside workflow:)
  var_name: value
```

**Rule:** Exactly one of `tasks:` or `groups:` must be present — never both.

---

## Resources

Named resource profiles referenced by tasks via the `resource:` field.

```yaml
resources:
  default:              # every workflow has an implicit "default" profile
    cpu: 8
    gpu: 2
    memory: 32Gi        # must use binary units: Gi, Mi
    storage: 100Gi      # must use binary units: Gi, Mi
    platform: dgx-h100  # target hardware platform
    nodesExcluded:       # exclude specific nodes
    - bad-node-01
    topology:            # advanced placement constraints
    - key: <string>
      group: <string>
      requirementType: <string>

  gpu_heavy:            # custom named profile
    cpu: 16
    gpu: 8
    memory: 128Gi
    storage: 200Gi
```

Tasks use `resource: gpu_heavy` to select a profile. Default is `"default"`.

---

## Task Spec (`TaskSpec`)

Each task defines a container to run.

```yaml
tasks:
- name: <string>                   # unique task name
  image: <string>                  # container image
  command: [<string>, ...]         # entrypoint (required, non-empty)
  args: [<string>, ...]            # additional arguments
  resource: <string>               # name of resource profile (default: "default")
  lead: <bool>                     # required in multi-task groups (one per group)

  # Data I/O
  inputs: [...]                    # data inputs (see below)
  outputs: [...]                   # data outputs (see below)

  # Configuration
  environment:                     # environment variables
    KEY: "value"
  files:                           # inline files created in the container
  - path: /tmp/script.sh
    contents: |
      #!/bin/bash
      echo "Hello"
  - path: /tmp/data.bin
    contents: <base64_string>
    base64: true

  # Credentials
  credentials:
    my_credential: /mnt/creds      # mount credential at path
    my_secret:                      # or map env vars to secret keys
      ENV_VAR: secret_key

  # Advanced
  privileged: <bool>
  hostNetwork: <bool>
  volumeMounts: [...]              # host volume mounts
  downloadType: <string>           # download behavior
  cacheSize: <string>              # cache size
  backend: <string>                # per-task backend override

  # Checkpointing
  checkpoint:
  - path: /tmp/checkpoints
    url: s3://bucket/checkpoints
    frequency: 60s
    regex: '.*\.(pt|bin)$'         # optional filter

  # Error handling
  exitActions:
    COMPLETE: 0                    # exit 0 = success
    RESCHEDULE: 1-255              # non-zero = retry
    FAIL: 137                      # specific code = fail

  # Monitoring
  kpis:
    index: <int>
    path: <string>
```

---

## Inputs

Tasks can receive data from three sources:

### Task-to-task (data dependency)

```yaml
inputs:
- task: upstream_task_name
  regex: '.*\.csv$'        # optional: filter files
```

Creates a DAG dependency. Upstream task must complete before this task starts.
Access via `{{input:N}}` (0-indexed by position in the inputs list) or
`{{input:upstream_task_name}}`.

### URL (cloud storage)

```yaml
inputs:
- url: s3://bucket/data/
  regex: '.*\.png$'        # optional filter
```

Downloads from S3, GCS, Azure, Swift, or TOS at task start.

### Dataset (OSMO-managed)

```yaml
inputs:
- dataset:
    name: my_dataset
    path: /custom/mount    # optional
    regex: '.*'            # optional
```

---

## Outputs

### Dataset output

```yaml
outputs:
- dataset:
    name: my_output_dataset
    # optional: metadata, labels
```

The task writes to `{{output}}`, which OSMO uploads as a dataset on completion.
Fetch it with `osmo dataset download <name> <local-path>`.

### URL output

```yaml
outputs:
- url: s3://bucket/output/
```

Fetch URL outputs with `osmo data list --no-pager <url>` and
`osmo data download <url> <local-path>`.

### Update existing dataset

```yaml
outputs:
- update_dataset:
    name: existing_dataset
```

---

## Groups

Use groups when tasks need co-scheduling or network communication.

```yaml
groups:
- name: training_group
  barrier: true              # default true; wait for all tasks in group
  ignoreNonleadStatus: true  # default true; group status follows lead only
  tasks:
  - name: coordinator
    lead: true               # exactly one lead per multi-task group
    image: my-image
    command: ["python", "coord.py"]
  - name: worker
    image: my-image
    command: ["python", "worker.py", "--coord={{host:coordinator}}"]
```

### Group rules

- Exactly one task must have `lead: true` in multi-task groups.
- The group terminates when the lead task exits.
- `{{host:taskname}}` resolves to the DNS name of a task in the same group.
- `{{host:taskname}}` does NOT work across groups.

### Cross-group dependencies

Groups depend on each other through task-level `inputs:`:

```yaml
groups:
- name: stage1
  tasks:
  - name: produce
    lead: true
    command: ["bash", "-c", "echo data > {{output}}/out.txt"]

- name: stage2
  tasks:
  - name: consume
    lead: true
    command: ["bash", "-c", "cat {{input:0}}/out.txt"]
    inputs:
    - task: produce     # stage2 waits for ALL of stage1 to complete
```

---

## Special Tokens

Automatically set by OSMO — cannot be overridden with `--set`:

| Token | Resolves To |
|-------|-------------|
| `{{output}}` | Output directory path for this task |
| `{{input:N}}` | Nth input path (0-indexed by `inputs:` list order) |
| `{{input:taskname}}` | Input path by upstream task name |
| `{{host:taskname}}` | DNS name of a task in the same group |
| `{{workflow_id}}` | Unique workflow run ID |

These tokens work in `command`, `args`, `environment` values, and `files` contents.

---

## Jinja Templates

Make workflows configurable at submit time:

```yaml
workflow:
  name: "{{workflow_name}}"
  resources:
    default:
      gpu: {{gpu_count}}
  tasks:
  - name: train
    image: "{{image}}"
    command: ["python", "train.py"]
    args: ["--epochs={{epochs}}"]

default-values:
  workflow_name: my-training
  gpu_count: 1
  image: nvcr.io/nvidia/pytorch:24.01-py3
  epochs: 10
```

```bash
# Submit with defaults
osmo workflow submit template.yaml --pool my-pool

# Override values
osmo workflow submit template.yaml --pool my-pool --set gpu_count=4 epochs=50
```

Jinja supports loops and conditionals:

```yaml
tasks:
{% for i in range(num_workers) %}
- name: worker-{{i}}
  image: my-image
  command: ["python", "worker.py", "--id={{i}}"]
{% endfor %}
```

---

## Cookbook Examples

Real-world examples in the OSMO repo under `cookbook/`:

| Example | Pattern |
|---------|---------|
| `tutorials/hello_world.yaml` | Minimal single task |
| `tutorials/template_hello_world.yaml` | Jinja template with defaults |
| `tutorials/serial_workflow.yaml` | Serial task chain |
| `tutorials/parallel_tasks.yaml` | Independent parallel tasks |
| `tutorials/group_tasks.yaml` | Synchronized group |
| `tutorials/group_tasks_communication.yaml` | `{{host:...}}` inter-task networking |
| `tutorials/combination_workflow_complex.yaml` | Multi-group pipeline with data flow |
| `tutorials/data_download.yaml` | S3 URL input |
| `tutorials/dataset_upload.yaml` | Dataset output with `{{output}}` |
| `tutorials/resources_platforms.yaml` | Multiple resource profiles + platforms |
| `tutorials/resources_basic.yaml` | Basic resource configuration |
| `dnn_training/torchrun_multinode/train.yaml` | Multi-node distributed training |
| `reinforcement_learning/single_gpu/train_policy.yaml` | RL training with GPU |
| `integration_and_tools/jupyterlab/jupyter.yaml` | Interactive Jupyter session |
| `integration_and_tools/vscode/vscode.yaml` | VS Code remote session |
