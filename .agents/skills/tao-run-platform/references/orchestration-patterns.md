# Orchestration patterns

Job chaining, parallel sweeps, and run-folder durability for the TAO SDK.
Read this when the agent is building a workflow with more than one
`create_job` call, sweeping a parameter, or wants resumable state across
context breaks.

## Multi-step workflows

The agent chains jobs by waiting for a parent to complete, then
constructing the next job's command using the parent's results directory:

```python
# Step 1: train
train = sdk.create_job(image=img, command=train_cmd, gpu_count=8, ...)
while sdk.get_job_status(train.id).status not in ("Complete", "Error"):
    time.sleep(30)
assert sdk.get_job_status(train.id).status == "Complete"

# Step 2: evaluate (uses the train results dir)
ckpt = f"{train.results_dir}/best.pth"
eval_cmd = make_eval_command(checkpoint=ckpt, ...)
eval_job = sdk.create_job(image=img, command=eval_cmd, gpu_count=1, ...)
```

There is no `SkillBank`, `Planner`, or `parent_job_id` mechanism —
workflow orchestration is the agent's job, not the SDK's.

## Parallel execution

```python
jobs = [sdk.create_job(image=img, command=make_cmd(i), gpu_count=1, ...) for i in range(8)]
# Poll all
while not all(sdk.get_job_status(j.id).status in ("Complete", "Error") for j in jobs):
    time.sleep(30)
```

## Run-folder durability with `ActionWorkflow`

Optional state-persistence helper for skills that want a durable run folder
across context breaks. Decoupled from any specific platform.

```python
from datetime import datetime
from tao_sdk.action_workflow import ActionWorkflow
from tao_sdk.platforms.lepton import LeptonSDK

ts = datetime.now().strftime("%Y%m%d_%H%M%S")
workflow = ActionWorkflow(root_dir="./runs", run_name="dino-train", timestamp=ts)
sdk = LeptonSDK(state_file=str(workflow.workspace / "tao_session_state.json"))

workflow.write_metadata(network="dino", action="train", dataset_uri="s3://bucket/coco/")
job = sdk.create_job(image=..., command=..., gpu_count=8, ...)
workflow.write_submission(job=job, specs=specs, script_runner={})
workflow.sync_from_sdk(sdk, job.id)  # writes status.json + latest_logs.txt + failure_analysis.json
```

The folder layout (`./runs/dino-train/<timestamp>/`):
- `metadata.json` — what the user asked for
- `status.json` — current job status snapshot
- `status_events.jsonl` — append-only event log
- `active_jobs.json` — in-flight job IDs (drained on terminal)
- `latest_logs.txt` — last polled log tail
- `failure_analysis.json` — populated on failure

Re-attach later with `ActionWorkflow.from_workspace(path)`. Works with any
SDK that has `get_job_status` / `get_job_logs` / `get_failure_analysis` —
Lepton, Brev, Docker, SLURM, Kubernetes.
