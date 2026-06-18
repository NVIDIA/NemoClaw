# OSMO Workflow Patterns Reference

Read this file when generating a **multi-task, parallel, pipelined, or templated**
workflow. The basic single-task scaffold in SKILL.md is sufficient for simple jobs;
this reference covers everything beyond that.

## Table of Contents

- [Critical Rules](#critical-rules)
- [Pattern 1: Independent Parallel Tasks](#pattern-1-independent-parallel-tasks)
- [Pattern 2: Serial Tasks with Data Dependencies](#pattern-2-serial-tasks-with-data-dependencies)
- [Pattern 3: Synchronized Groups (Parallel with Coordination)](#pattern-3-synchronized-groups-parallel-with-coordination)
- [Pattern 4: Combination Pipelines (Serial Groups, Parallel Within)](#pattern-4-combination-pipelines-serial-groups-parallel-within)
- [Pattern 5: Jinja Templates](#pattern-5-jinja-templates)

---

## Critical Rules

- **`tasks:` and `groups:` are mutually exclusive** at the workflow level — never mix them
- **Memory and storage must use binary units**: `Gi`, `Mi` — never `GB` or `MB`
- **Every group must have exactly one `lead: true` task** — the group terminates when the lead exits, so make sure the lead outlives its non-lead siblings
- **`{{input:N}}` is 0-indexed** and ordered by the `inputs:` list on that task

---

## Pattern 1: Independent Parallel Tasks

Tasks defined under `tasks:` with no `inputs:` between them run simultaneously. This is
the simplest form of parallelism — no coordination needed.

```yaml
workflow:
  name: parallel-tasks
  tasks:
  - name: task-a
    image: alpine:3.18
    command: ["echo", "Hello from task-a"]

  - name: task-b
    image: alpine:3.18
    command: ["echo", "Hello from task-b"]

  - name: task-c
    image: alpine:3.18
    command: ["echo", "Hello from task-c"]
```

All three tasks start at the same time. They cannot communicate with each other over
the network. Use this pattern for embarrassingly parallel workloads (batch processing,
hyperparameter sweeps, independent eval runs).

---

## Pattern 2: Serial Tasks with Data Dependencies

Add an `inputs:` section to a task to declare that it depends on another task's output.
OSMO automatically waits for the upstream task, then makes its output available at
`{{input:N}}` (0-indexed, matching the order of the `inputs:` list).

```yaml
workflow:
  name: serial-tasks
  tasks:

  - name: task1
    image: ubuntu:22.04
    command: [sh]
    args: [/tmp/run.sh]
    files:
    - contents: |
        echo "Data from task 1" > {{output}}/result.txt
      path: /tmp/run.sh

  - name: task2
    image: ubuntu:22.04
    command: [sh]
    args: [/tmp/run.sh]
    files:
    - contents: |
        # task1's output is at {{input:0}}
        cat {{input:0}}/result.txt
        echo "Data from task 2" > {{output}}/result.txt
      path: /tmp/run.sh
    inputs:
    - task: task1   # creates dependency AND data flow

  - name: task3
    image: ubuntu:22.04
    command: [sh]
    args: [/tmp/run.sh]
    files:
    - contents: |
        cat {{input:0}}/result.txt   # from task1
        cat {{input:1}}/result.txt   # from task2
      path: /tmp/run.sh
    inputs:
    - task: task1
    - task: task2
```

If a task fails, all downstream dependents are automatically canceled.

---

## Pattern 3: Synchronized Groups (Parallel with Coordination)

Use `groups:` when tasks need to **start together** and/or **communicate over the
network** (e.g. distributed training, client-server). All tasks in a group launch
simultaneously; the group is considered complete when the lead task exits.

```yaml
workflow:
  name: grouped-workflow
  groups:
  - name: parallel-processing
    tasks:
    - name: processor-1
      lead: true          # required — group ends when this task exits
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args:
      - |
        echo "Processor 1 running..."
        sleep 30
        echo "Processor 1 done"

    - name: processor-2
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args:
      - |
        echo "Processor 2 running..."
        sleep 10
        echo "Processor 2 done"
```

### Inter-task communication within a group

Tasks in the same group can reach each other using `{{host:task-name}}`, which resolves
to the IP address of that task at runtime:

```yaml
workflow:
  name: client-server
  groups:
  - name: parallel-processing
    tasks:
    - name: server
      lead: true
      image: alpine:3.18
      command: ["sh", "-c"]
      args:
      - |
        echo "hello" > /tmp/hello.txt
        nc -w 50 -l -p 24831 < /tmp/hello.txt

    - name: client
      image: alpine:3.18
      command: ["sh", "-c"]
      args:
      - |
        nc -w 30 {{host:server}} 24831 > /tmp/received.txt
        echo "Got: $(cat /tmp/received.txt)"
```

`{{host:task-name}}` only works within the same group — tasks in different groups
cannot use it.

---

## Pattern 4: Combination Pipelines (Serial Groups, Parallel Within)

Groups can depend on each other through task-level `inputs:`. When any task in a group
declares an input from a task in another group, **the entire downstream group waits for
the entire upstream group to complete**.

This gives you serial execution *between* groups and parallel execution *within* groups.

```yaml
workflow:
  name: data-pipeline
  groups:
  # Group 1: runs first
  - name: prepare-data
    tasks:
    - name: generate-dataset
      lead: true
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args:
      - |
        mkdir -p {{output}}/data
        echo "sample_1,value_1" >> {{output}}/data/dataset.csv
        echo "sample_2,value_2" >> {{output}}/data/dataset.csv

    - name: validate-data
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args: ["echo Validating..."]

  # Group 2: waits for Group 1 via task inputs
  - name: train-models
    tasks:
    - name: train-model-a
      lead: true
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args:
      - |
        cat {{input:0}}/data/dataset.csv
        echo "Model A trained"
      inputs:
      - task: generate-dataset   # establishes group dependency

    - name: train-model-b
      image: ubuntu:24.04
      command: ["bash", "-c"]
      args:
      - |
        wc -l {{input:0}}/data/dataset.csv
        echo "Model B trained"
      inputs:
      - task: generate-dataset
```

**Execution flow:** `prepare-data` group completes → `train-models` group starts with
both `train-model-a` and `train-model-b` running in parallel.

> **Lead task caution:** If the lead task finishes before non-lead tasks in its group,
> the group terminates early. Ensure the lead task's duration covers its siblings, or
> use a barrier script to synchronize completion.

---

## Pattern 5: Jinja Templates

Use Jinja templates to make workflows configurable at submission time without editing
the YAML. Variables use `{{ }}` syntax; defaults live in a `default-values:` block at
the top level (outside `workflow:`).

```yaml
workflow:
  name: "{{workflow_name}}"

  resources:
    training:
      cpu: 8
      memory: 32Gi
      gpu: {{gpu_count}}

  tasks:
  {% for i in range(num_tasks) %}
  - name: train-model-{{i}}
    image: {{training_image}}
    command: ["python", "train.py"]
    args:
    - "--dataset={{dataset_name}}"
    - "--fold={{i}}"
    resource: training
    outputs:
    - dataset:
        name: "{{model_type}}_fold_{{i}}"
  {% endfor %}

default-values:
  workflow_name: ml-training
  dataset_name: imagenet
  model_type: resnet50
  num_tasks: 3
  gpu_count: 1
  training_image: nvcr.io/nvidia/pytorch:24.01-py3
```

Submit with defaults or override at the command line:

```bash
# Use defaults
osmo workflow submit template-workflow.yaml

# Override specific values
osmo workflow submit template-workflow.yaml \
    --set model_type=efficientnet \
    --set gpu_count=4 \
    --set num_tasks=5
```

**Special tokens** (set automatically by OSMO, cannot be overridden with `--set`):

| Token | Value |
|---|---|
| `{{output}}` | Path where this task should write output data |
| `{{input:N}}` | Path to the Nth upstream task's output (0-indexed) |
| `{{workflow_id}}` | Unique ID for this workflow run |
| `{{host:task-name}}` | IP address of a task in the same group |
