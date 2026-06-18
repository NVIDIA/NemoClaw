# OSMO Advanced Patterns Reference

Read this file only when the user's request clearly requires one of these specific
capabilities: **checkpointing**, **exit/retry behavior**, or **node exclusion**.
These are niche patterns not needed for most workflow generation tasks.

---

## Checkpointing

Automatically upload a task's working directory to S3 at a fixed interval while the
task runs. Useful for long-running training jobs where you want to preserve intermediate
results if the job is interrupted.

```yaml
tasks:
- name: train-with-checkpointing
  image: ubuntu:24.04
  command: [/bin/bash]
  args: [/tmp/run.sh]
  files:
  - path: /tmp/run.sh
    contents: |-
      #!/bin/bash
      set -ex
      mkdir -p /tmp/checkpoints
      python train.py --output /tmp/checkpoints
  checkpoint:
  - path: /tmp/checkpoints           # local directory to upload
    url: s3://my-bucket/checkpoints  # destination
    frequency: 60s                   # how often to sync
```

A final checkpoint is always uploaded when the task completes, regardless of interval.

### Checkpoint only specific files

Use a regex to filter which files get uploaded:

```yaml
checkpoint:
- path: /tmp/checkpoints
  url: s3://my-bucket/checkpoints
  frequency: 60s
  regex: .*\.(bin|pt)$   # only upload .bin and .pt files
```

---

## Error Handling with Exit Actions

Control what happens when a task exits with a specific exit code. Useful for automatic
retry logic.

```yaml
tasks:
- name: resilient-task
  image: ubuntu:24.04
  command: ["bash", "-c", "python fetch_and_process.py"]
  exitActions:
    COMPLETE: 0       # exit code 0 → task completes normally
    RESCHEDULE: 1-255 # any non-zero exit → task is rescheduled (retried)
```

Available actions: `COMPLETE`, `RESCHEDULE`, `FAIL`. Ranges and comma-separated lists
of exit codes are supported (e.g. `1,2,5` or `1-10`).

---

## Excluding Specific Nodes

Prevent a workflow from scheduling on known-problematic nodes using `nodesExcluded`
in the resource spec:

```yaml
workflow:
  name: exclude-nodes-demo
  resources:
    default:
      cpu: 4
      memory: 16Gi
      storage: 50Gi
      nodesExcluded:
      - worker-node-01
      - worker-node-02
  tasks:
  - name: my-task
    image: ubuntu:24.04
    command: ["bash", "-c", "echo Running on a healthy node"]
```

> **Warning:** Excluding too many nodes can cause tasks to remain PENDING indefinitely.
> Only use this when specific nodes are confirmed to have hardware or network issues.
