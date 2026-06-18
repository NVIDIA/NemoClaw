# OSMO Platform And CLI

## Table of Contents

- [Prerequisites](#prerequisites)
- [Reference Files](#reference-files)
- [Intent Routing](#intent-routing)
- [Use Case: Check Available Resources](#use-case-check-available-resources)
- [Use Case: Generate and Submit a Workflow](#use-case-generate-and-submit-a-workflow)
- [Use Case: Orchestrate a Workflow End-to-End](#use-case-orchestrate-a-workflow-end-to-end)
- [Use Case: List Workflows](#use-case-list-workflows)
- [Use Case: Check Workflow Status](#use-case-check-workflow-status)
- [Use Case: Fetch Workflow Data](#use-case-fetch-workflow-data)
- [Use Case: Explain What a Workflow Does](#use-case-explain-what-a-workflow-does)
- [Use Case: Create an App](#use-case-create-an-app)
- [Compatibility Reference: Run a Workflow Locally](#compatibility-reference-run-a-workflow-locally)
- [Use Case: Set Up an Image Registry Credential](#use-case-set-up-an-image-registry-credential)
- [Quick Command Reference](#quick-command-reference)
- [Workflow Spec Quick Reference](#workflow-spec-quick-reference)
- [Environment Variables](#environment-variables)
- [Architecture at a Glance](#architecture-at-a-glance)


## Overview

OSMO is a workflow orchestration platform for Physical AI. It manages
heterogeneous Kubernetes clusters and provides a CLI (`osmo`) for submitting
workflows, managing data, and monitoring jobs. This skill covers end-to-end
OSMO use cases plus a complete CLI command and workflow-spec reference.

## Prerequisites

The CLI must be installed at version 6.3.0 or newer and authenticated. Run
`scripts/preflight.sh` before workflow submit/query work.

```bash
osmo login <OSMO_URL>           # device-code flow (default)
osmo login <OSMO_URL> --method password --username <user> --password <pass>
osmo login <OSMO_URL> --method token --token-file /path/to/refresh_token
```

Credentials are stored in `~/.config/osmo/login.yaml` (or `$OSMO_CONFIG_FILE_DIR`).

## Reference Files

Run `scripts/preflight.sh` first when this component is selected. It checks the
OSMO CLI binary and minimum supported version.

The `agents/` directory contains instructions for specialized subagents. Read
them when you need to spawn the relevant subagent.

- `agents/workflow-expert.md` — workflow generation, resource check, submission, failure diagnosis
- `agents/logs-reader.md` — log fetching and summarization for monitoring and failure diagnosis

The `references/` directory has additional documentation:

- `references/cli-commands.md` — Full CLI command reference with all flags
- `references/workflow-spec.md` — Complete workflow YAML schema and examples
- `references/workflow-patterns.md` — Multi-task, parallel execution, data dependencies, Jinja templating
- `references/advanced-patterns.md` — Checkpointing, retry/exit behavior, node exclusion

---

## Intent Routing

- Asks about resources, pools, GPUs, or quota → **Check Available Resources**
- Wants to submit a job (simple, no monitoring) → **Generate and Submit a Workflow**
- Wants to submit + monitor + handle failures → **Orchestrate a Workflow End-to-End**
- Asks about a workflow's status or logs → **Check Workflow Status**
- Asks to fetch, inspect, list, or download workflow results/output/data → **Fetch Workflow Data**
- Lists recent workflows → **List Workflows**
- Asks what a workflow does → **Explain What a Workflow Does**
- Wants to publish a workflow as an app → **Create an App**
- Wants to run a workflow locally (no cluster) → out of scope for infrastructure setup; use this component only as a compatibility CLI reference.
- Asks about image/registry/pull credentials, `nvcr.io` pull secrets, "how do I set the credential", `osmo credential set`, or a workflow that fails to pull a private image → **Set Up an Image Registry Credential**
- Asks for a command's syntax, flags, or purpose → jump to **Quick Command Reference** below (or `references/cli-commands.md`)
- Asks about workflow YAML schema → jump to **Workflow Spec Quick Reference** below (or `references/workflow-spec.md`)

---

## Use Case: Check Available Resources

**When to use:** The user asks what resources, nodes, GPUs, or pools are available
(e.g. "what resources are available?", "what nodes can I use?", "do I have GPU quota?",
"what pools do I have access to?").

### Steps

1. **Check accessible pools** — run to see which pools the user's profile has access to:
   ```bash
   osmo profile list
   ```
   This returns the user's profile settings, including which pools they belong to.

2. **Check pool resources** — run to see GPU availability across all accessible pools:
   ```bash
   osmo pool list
   ```
   By default this shows used/total GPU counts. To see what's free instead:
   ```bash
   osmo pool list --mode free
   ```

### Reading the output

The `osmo pool list` table columns mean:

| Column | Meaning |
|---|---|
| Quota Limit | Max GPUs for HIGH/NORMAL priority workflows |
| Quota Used | GPUs currently consumed by your workflows |
| Quota Free | GPUs you can still allocate |
| Total Capacity | All GPUs on nodes in the pool |
| Total Usage | GPUs used by everyone in the pool |
| Total Free | GPUs physically free on nodes |

When summarizing results for the user, highlight:
- Which pools they have access to
- Effective availability = min(Quota Free, Total Free) — this is the true number of
  GPUs a workflow can actually use, since both limits apply
- Any pools that appear at capacity
- **LOW priority opportunity:** if a pool has Quota Free = 0 but Total Free > 0, the
  user's quota is exhausted but physical GPUs are physically idle. They can still submit
  with `--priority LOW`, which bypasses quota limits and runs on available capacity.
  Mention this as an option whenever you see this condition.

### Output format (required for resource availability responses)

Use a grouped, table-first format similar to:
"You have access to <N> pools, <M> ONLINE. Here are the highlights by GPU type:"

Formatting requirements:
- Group results by GPU type with section headers like `GB200 Pools`, `H100 Pools`,
  `L40S Pools`, `L40 Pools` (and `Other Pools` when needed). Do not enforce a fixed
  ordering; use whatever order is most readable for the current result set.
- Render one fixed-width table per GPU type (box-drawing style preferred; markdown
  table is acceptable fallback).
- Include these columns in each table:
  - `Pool`
  - `Quota Free`
  - `Physically Free` (from `Total Free`; keep markers like `(shared)` when present)
  - `Effective` (computed as `min(Quota Free, Total Free)`)
- Sort rows within each GPU-type section by `Effective` descending.
- Add useful inline annotations in cells when relevant:
  - Append `(default)` to the user's default pool name.
  - Optionally mark the top pool in a section as `✅ Most available`.
- After the grouped tables, add a short callout for:
  - Pools at capacity (`Effective = 0`)
  - LOW-priority opportunities (`Quota Free = 0` and `Total Free > 0`)

Derive GPU type from pool names when possible:
- contains `gb200` -> `GB200`
- contains `h100` -> `H100`
- contains `l40s` -> `L40S`
- contains `l40` -> `L40`
- otherwise -> `Other`

---

## Use Case: Generate and Submit a Workflow

**When to use:** The user wants to submit a job to run on OSMO (e.g. "submit a workflow
to run SDG", "run RL training for me", "submit this yaml to OSMO").

If the user also wants monitoring, debugging, or reporting results, use the
"Orchestrate a Workflow End-to-End" use case instead.

### Steps

1. **Get or generate a workflow spec.**

   If the user provides a workflow YAML, use it as-is. Otherwise, generate one based on
   what they want to run. Write the spec to `workflow.yaml` in the current directory.

   **When generating a workflow spec:**
   - Fetch the cookbook README via WebFetch to browse available examples:
     `https://raw.githubusercontent.com/NVIDIA/OSMO/main/cookbook/README.md`
     Pick the closest match to the user's request. The cookbook README links to each
     workflow's per-workflow README. To fetch the workflow YAML:
     1. Fetch the per-workflow README at the linked path (e.g.
        `https://raw.githubusercontent.com/NVIDIA/OSMO/main/cookbook/<path>/README.md`).
     2. Read that README to find the workflow YAML filename (do not assume it is
        `workflow.yaml` — look for the actual filename referenced in the README).
     3. Construct the workflow YAML URL as `<per-workflow README directory URL>/<filename>`
        and fetch it.
     Use the YAML as a starting point — adapt it rather than generating from scratch.
     Summarize the per-workflow README and add it as a comment in the generated workflow spec.
   - **Preserve Jinja template variables.** If the cookbook YAML uses `{{variable}}`
     placeholders (e.g. `{{num_gpu}}`), do NOT replace or hardcode them in the YAML.
     Keep the template variables as-is and pass the user's values via `--set` at submit
     time. Multiple variables are space-separated after a single `--set`:
     ```bash
     osmo workflow submit workflow.yaml --pool <pool_name> --set num_gpu=4 other_var=value
     ```
     Do not manually scale `resources` values to match the user's requested GPU count —
     the template handles this.
   - **Use workflow README and YAML to decide submission count.** After fetching those
     two files, find the throughput and constraint metadata
     (e.g. "60 images"). Before deciding whether to submit one or multiple
     workflows, read those annotations:
     - If a throughput figure is present and the user has a target quantity + time
       budget, calculate: `num_submissions = ceil(target / (throughput_per_run * time_budget))`
       and submit the same YAML that many times.
     - For scaling workflows, if a workflow's resource spec uses variables, then you can pass
       a new value in the submit call. If a resource spec uses constants, scale by submitting
       more workflows instead of requesting more GPUs, CPUs, etc. for a workflow.
     - If no metadata is present, submit a single workflow unless the user says otherwise.
   - If the workflow involves **multiple tasks, parallel execution, data dependencies
     between tasks, or Jinja templating**, read `references/workflow-patterns.md` for
     the correct spec patterns before writing anything.
   - If the user asks for **checkpointing, retry/exit behavior, or node exclusion**,
     read `references/advanced-patterns.md`.
   - For the complete YAML schema (all fields, inputs, outputs, groups, credentials,
     checkpoints, exit actions, Jinja templating), read `references/workflow-spec.md`.
   - If no cookbook example closely matches, fall back to the scaffold template below.

   The simple OSMO workflow spec format follows this structure:
   ```yaml
   workflow:
     name: <workflow-name>
     tasks:
     - name: <task-name>
       image: <container-image>
       command: ["bash"]
       args: ["/tmp/entry.sh"]
       environment:
         <ENV VARIABLE>: <VALUE>
       files:
       - contents: |
           <shell script to run>
         path: /tmp/entry.sh
       outputs:
       - dataset:
           name: <output-dataset-name>
     resources:
       default:
         cpu: <N>
         gpu: <N>
         memory: <NGi>
         storage: <NGi>
   ```

   Use `{{output}}` as a placeholder in the script wherever the task should write its
   output data — OSMO replaces this at runtime with the output mount path.

2. **Ask the user what GPU type they want** (e.g. H100, L40, GB200), then check
   availability using the steps in the "Check Available Resources" use case to confirm
   the right pool to use.

3. **Ask the user for confirmation with this exact wording:**
   `Would you like me to submit this workflow to this pool?`
   Then execute the command yourself — do not tell the user to run it. Once confirmed, run:
   ```bash
   osmo workflow submit workflow.yaml --pool <pool_name> --set key=value other_key=value
   ```
   Include `--set` only when the workflow has Jinja template variables to override
   (e.g. `--set num_gpu=4`). Omit it if the YAML has no template variables.
   If the user wants to run the same workflow multiple times (e.g. "submit 2 of these"),
   submit the same YAML file multiple times — do not create duplicate YAML files.
   Report each workflow ID returned by the CLI so the user can track them.

   **When quota is exhausted but GPUs are physically free (Quota Free = 0, Total Free > 0):**
   Offer to submit with `--priority LOW`, which bypasses quota limits and schedules on
   idle capacity. LOW priority jobs may be preempted if quota-holding jobs need those
   GPUs, so let the user know before proceeding. If they agree, run:
   ```bash
   osmo workflow submit workflow.yaml --pool <pool_name> --priority LOW
   ```

   **Validation errors:** If submission fails with a validation error indicating that
   resources failed assertions, read the node capacity values from the error table and
   adjust the hard-coded values in the `resources` section of `workflow.yaml` using these
   rules, then resubmit. (Do not touch Jinja template variables like `{{num_gpu}}` —
   those are resolved at runtime via `--set`.)

   - **Storage / Memory:** use `floor(capacity * 0.9)` if capacity ≥ 50, otherwise `capacity - 2`
   - **CPU:** use `floor(capacity * 0.9)` if capacity ≥ 30, otherwise `capacity - 2`
   - **GPU:** always use a multiple of 2; do not adjust based on node capacity
   - **Proportionality:** after setting GPU, scale memory and CPU proportionally to the
     ratio of requested GPUs to total allocatable GPUs on the node
     (e.g. requesting 2 of 8 GPUs → use 25% of the adjusted memory/CPU values)

---

## Use Case: Orchestrate a Workflow End-to-End

**When to use:** The user wants to create a workflow, submit it, and monitor it to
completion (e.g. "train GR00T on my data", "submit and monitor my workflow",
"run end-to-end training", "submit this and tell me when it's done").

### Steps

The lifecycle is split between the `workflow-expert` subagent (workflow generation,
resource check, submission, failure diagnosis) and **you** (live monitoring so the
user sees real-time updates).

1. **Spawn the workflow-expert subagent for setup and submission.**

   Ask it to **write workflow YAML if needed, check resources, and submit only**.
   Do NOT ask it to monitor, poll status, or report results — that is your job.

   Example prompt:
   > Create a workflow based on user's request, if any. Check resources first,
   > then submit the workflow to an available resource pool. Return the workflow
   > ID when done.

   The subagent returns: workflow ID, pool name, and OSMO Web link.

2. **Monitor the workflow inline (you do this — user sees live updates).**

   Use the "Check Workflow Status" use case to poll and report. Repeat until a
   terminal state is reached. Adjust the polling interval based on how long you
   expect the workflow to take — poll more frequently for short jobs (every 10-15s)
   and less frequently for long training runs (every 30-60s). Report each state
   transition to the user:
   - `Status: SCHEDULING (queued 15s)`
   - `Workflow transitioned: SCHEDULING → RUNNING`
   - `Status: RUNNING (task "train" active, 2m elapsed)`

3. **Handle the outcome.**

   **If COMPLETED:** Report results — workflow ID, OSMO Web link, output URLs/datasets.
   Then follow "Fetch Workflow Data" for listing/downloading results.

   **If FAILED:** First, fetch logs using the log-fetching rule from "Check Workflow
   Status" Step 2 (1 task = inline, 2+ tasks = delegate to logs-reader subagents).
   Then resume the `workflow-expert` subagent (use the `resume` parameter with the
   agent ID from Step 1) and pass the logs summary: "Workflow <id> FAILED. Here is
   the logs summary: <summary>. Diagnose and fix." It returns a new workflow ID.
   Resume monitoring from Step 2. Max 3 retries before asking the user for guidance.

---

## Use Case: List Workflows

**When to use:** The user wants to see all their workflows or recent submissions (e.g.
"what are my workflows?", "show me my recent jobs", "what's the status of my workflows?").

### Steps

1. **List all workflows:**
   ```bash
   osmo workflow list --format-type json
   ```

2. **Summarize results** in a table showing workflow name, pool, status, and duration.
   Group or sort by status if helpful. Use clear symbols to indicate outcome:
   - ✅ COMPLETED
   - ❌ FAILED / FAILED_CANCELED / FAILED_EXEC_TIMEOUT / FAILED_SERVER_ERROR
   - 🔄 RUNNING
   - ⏳ PENDING

---

## Use Case: Check Workflow Status

**When to use:** The user asks about the status or logs of a workflow (e.g. "what's the
status of workflow abc-123?", "is my workflow done?", "show me the logs for xyz",
"show me the resource usage for my workflow", "give me the Kubernetes dashboard link").
Also used as the polling step when monitoring a workflow during end-to-end orchestration.

### Steps

1. **Get the workflow status:**
   ```bash
   osmo workflow query <workflow name> --format-type json
   ```
   **Cache the JSON result for the rest of the conversation.** If you have already queried
   this workflow with `osmo workflow query` earlier in the conversation, reuse that JSON
   — do not query again just to extract a field.

2. **Get recent logs** — Choose the log-fetching method based on task count
   (this rule applies everywhere logs are needed — monitoring, failure diagnosis, etc.):
   - **1 task:** fetch logs inline with `osmo workflow logs <workflow_id> -n 200`.
   - **2+ tasks:** you MUST delegate to `agents/logs-reader.md` subagents — do NOT
     fetch logs inline yourself. Spawn one logs-reader subagent per 5 tasks
     (e.g. 3 tasks → 1 subagent, 7 tasks → 2 subagents).

   Canonical diagnostics commands are:

   ```bash
   osmo workflow query <workflow_id> --format-type json
   osmo workflow events <workflow_id>
   osmo workflow logs <workflow_id> --task <task_name> -n 200
   osmo workflow spec <workflow_id>
   kubectl get pods -n osmo-workflows
   osmo data list <output_uri>
   osmo data download <output_uri> <local_dir>
   ```

   Do not use invalid status/tasks subcommands from failed transcripts,
   command-root pager flags, or positional task names for logs. Task log
   filtering uses `--task <task_name>`.

3. **Report to the user:**
   - State the current status clearly (e.g. RUNNING, COMPLETED, FAILED, PENDING)
   - Concisely summarize what the logs show — what stage the job is at, any errors,
     or what it completed successfully
   - If the workflow failed, highlight the error and suggest next steps if possible
   - **Resource usage / Grafana link:** If the user asks about resource usage, GPU
     utilization, or metrics for this workflow, extract `grafana_url` from the query
     JSON. If present, render it as a clickable link:
     `[View resource usage in Grafana](<grafana_url>)`
     If the field is empty or null, tell the user: "The Grafana resource usage link is
     not available for this workflow."
   - **Kubernetes dashboard link:** If the user asks for the Kubernetes dashboard,
     pod details, or a k8s link, extract `kubernetes_dashboard` from the query JSON.
     If present, render it as a clickable link:
     `[Open Kubernetes dashboard](<kubernetes_dashboard>)`
     If the field is empty or null, tell the user: "The Kubernetes dashboard link is
     not available for this workflow."
   - Proactively include both links in any detailed status report (e.g. when the
     workflow is RUNNING or has just COMPLETED) — users often want them without
     explicitly asking. If a field is empty or null, note it as not available rather
     than silently omitting it.
   - **If PENDING** (or the user asks why it isn't scheduling), run:
     ```bash
     osmo workflow events <workflow name>
     ```
     Translate Kubernetes events into plain language (e.g. "there aren't enough free
     GPUs in the pool" rather than "Insufficient nvidia.com/gpu"). Also check:
     ```bash
     osmo resource list -p <pool>
     ```
   - If COMPLETED, proceed to Step 4.

4. **Handle completed workflows:**

   If the workflow produced output URLs or the user asks for results, follow
   **Fetch Workflow Data**. Prefer `osmo data list --no-pager` and
   `osmo data download` for URL outputs such as `s3://osmo-workflows/...`.
   Use `osmo dataset download` only for declared OSMO-managed dataset outputs.

   Also offer to create an OSMO app. Suggest a name derived from the workflow name
   (e.g. `sdg-run-42` → app name `sdg-run-42`) and generate a one-sentence description.
   If the user agrees, follow the "Create an App" use case.

   When monitoring multiple workflows from the same spec, offer app creation once
   (not per workflow) after all reach a terminal state. Do not skip this offer
   just because you were in a batch monitoring loop.

---

## Use Case: Fetch Workflow Data

**When to use:** The user asks for workflow results, output files, artifacts, data
download, or how to access an OSMO workflow's object-storage output.

### Steps

1. **Find the output URI.** If the user provided a URI, use it. Otherwise query
   the workflow and inspect both workflow-level outputs and task outputs:
   ```bash
   osmo workflow query <workflow_id> --format-type json
   osmo workflow spec <workflow_id>
   ```
   Use concrete rendered `outputs[].url` values when present. Common physical AI
   workflow storage is under `s3://osmo-workflows/<workflow_id>/`. This is an
   OSMO/MinIO storage URI, not an AWS S3 bucket.

2. **Use `osmo data` for local MicroK8s MinIO too.** If this is a local OSMO
   cluster on MicroK8s, do not treat `s3://osmo-workflows` as real AWS S3 and
   do not read the MinIO disk path directly:
   ```bash
   /var/snap/microk8s/common/default-storage/minio-operator-data*/data/osmo-workflows/
   ```
   MinIO chunks objects and encrypts them at rest, so those files are not
   directly usable. Access workflow data through `osmo data`.

3. **List files before downloading.** Use `--no-pager` for non-interactive
   runs. List the bucket root if you need to discover run folders:
   ```bash
   osmo data list --no-pager s3://osmo-workflows
   osmo data list --no-pager <output-uri>
   osmo data list --no-pager --recursive <output-uri>
   ```

4. **Download to a local path the user or calling agent can access.** For quick
   inspection, `/tmp/<workflow_id>-data` is a good default when the user did not
   request a path:
   ```bash
   osmo data download <output-uri> /tmp/<workflow_id>-data
   ```
   Report both the remote URI and local path after the download completes.

5. **Dataset outputs are separate.** If the workflow declared `outputs:
   - dataset:`, use:
   ```bash
   osmo dataset download <dataset_name> <local-path>
   ```
   Do not use dataset commands for raw `s3://`, `az://`, `gs://`, or Swift/TOS
   URLs; use `osmo data` for those.

6. **Direct MinIO clients are fallback/debug tools.** Use `osmo data` for
   normal workflow data access. Locally, `mc` may already have an `osmo`
   alias configured; this is valid because it goes through MinIO:
   ```bash
   mc ls osmo/osmo-workflows/
   mc ls --recursive osmo/osmo-workflows/<workflow_id>/
   mc cp --recursive osmo/osmo-workflows/<workflow_id>/ /tmp/<workflow_id>-data/
   ```
   Use `$MINIO_USER`, `$MINIO_PASS`, `$MINIO_ENDPOINT`, or other S3 clients only
   for explicit MinIO administration/debugging.

---

## Use Case: Explain What a Workflow Does

**When to use:** The user asks what a workflow does, what it's configured to run, or
wants to understand its purpose (e.g. "what does workflow abc-123 do?", "explain this
workflow", "what is workflow xyz running?").

### Steps

1. **Fetch the workflow template:**
   ```bash
   osmo workflow spec <workflow name> --template
   ```
   This returns the original workflow spec YAML that was used to submit the job,
   including the container image, entrypoint scripts, environment variables, and
   resource requests.

2. **Read and summarize the spec.** Based on the YAML output, give the user a concise
   plain-language summary covering:
   - **What it does**: the high-level task (e.g. "runs SDG data generation using the
     Isaac container", "trains a policy with RL")
   - **How it runs**: the container image, the entrypoint script or command, and any
     notable environment variables that control its behavior
   - **What it produces**: any declared outputs (datasets, artifacts)

   Keep the summary short — a few sentences or a brief bullet list. The user asked
   what it does, not for a line-by-line YAML walkthrough.

---

## Use Case: Create an App

**When to use:** The user wants to publish a workflow as an OSMO app (e.g. "create an
app for this workflow", "make an app from my workflow", "publish this as an app"), or
you are proactively offering app creation after a workflow completes.

### Steps

1. **Determine the workflow file path.** If the user already has a workflow YAML (e.g.
   `workflow.yaml` in the current directory), use that path. If they're coming from a
   completed workflow, use the spec file that was submitted.

2. **Decide on a name and description.**

   - **If the user explicitly asked to create an app**, ask them what they'd like to
     name it. Suggest a name based on the workflow name (e.g. `sdg-run` → `sdg-run-app`)
     so they have a sensible default to accept or override. Also generate a one-sentence
     description summarizing what the workflow does, and confirm it with the user before
     proceeding.

   - **If you are proactively offering** (post-completion), present your suggested name
     and description upfront — don't ask two separate questions. Something like:
     > "Would you like to create an app for this workflow? I'd suggest naming it
     > `sdg-isaac-app` with the description: 'Runs Isaac Lab SDG to generate
     > synthetic training data.' Does that work, or would you like to change anything?"

3. **Create the app** — once the user confirms name and description, run:
   ```bash
   osmo app create <app-name> --description "<description>" --file <path-to-workflow.yaml>
   ```
   Execute this yourself — do not ask the user to run it.

4. **Report the result** — confirm the app was created and share any URL or identifier
   returned by the CLI.

---

## Compatibility Reference: Run a Workflow Locally

**When to read:** The user explicitly asks for OSMO local Docker execution or
you are maintaining legacy OSMO CLI material. Do not use this path for Physical
AI infrastructure setup, scaling, or validation.

OSMO ships two local executors. Both support `--set`, `--credential NAME=PATH`,
`--shm-size`, and `--keep` (preserve containers for inspection).

### Steps

1. **Pick the executor:**
   - **`osmo standalone run`** — serial, one task at a time via `docker run`. Does NOT
     support `{{host:taskname}}` (no inter-task networking).
   - **`osmo docker-compose run`** — parallel within groups, supports `{{host:taskname}}`
     via shared Docker networks. Groups execute in topological order.

   If the spec uses `{{host:taskname}}`, you MUST use `docker-compose`.

2. **Run:**
   ```bash
   osmo standalone run -f workflow.yaml --keep
   osmo docker-compose run -f workflow.yaml --set key=val
   ```

3. **Resume a failed run** without re-executing completed tasks:
   ```bash
   osmo standalone run -f workflow.yaml --resume
   osmo standalone run -f workflow.yaml --from-step <task_name>
   ```

4. **Report results** — note any failing task, suggest `--keep` so the user can
   `docker exec` into the container for debugging.

---

## Use Case: Set Up an Image Registry Credential

**When to use:** The user needs to submit an OSMO workflow that pulls a private
container image (typically `nvcr.io/...`), or a submitted workflow fails to pull
its image. This is the canonical reference for `osmo credential set --type
REGISTRY` — any other skill that pulls private images from OSMO should point
here as a prerequisite.

`osmo credential set` is the ONLY supported command for registering a workflow
image-pull credential. The server stores it; tasks reference it by name and the
cluster uses it as an `imagePullSecret` at runtime.

### Steps

1. **Check for an existing credential first** — skip all the setup if it's
   already registered:
   ```bash
   osmo credential list
   ```
   Look for a `REGISTRY`-typed entry whose `registry=` matches the host you
   need (e.g. `nvcr.io`). If found, reuse its name in the workflow YAML
   (see Step 4) — no new credential needed.

2. **Resolve an NGC API key for `nvcr.io`.** Do not prompt the user until all
   automatic sources are exhausted:
   1. `$NGC_CLI_API_KEY` — baked in by many NVIDIA provisioning images and
      exported via `~/.bashrc` / `~/.profile`.
   2. `$NGC_API_KEY` — secondary fallback (also used by Physical AI skills).
   3. **User prompt** — only if both env vars are empty. Point them at
      https://ngc.nvidia.com/setup/api-key; stop work until provided (there is
      no anonymous fallback for private images).
   ```bash
   NGC_KEY="${NGC_CLI_API_KEY:-${NGC_API_KEY:-}}"
   ```

3. **Create the credential** with the exact flag shape below — the CLI uses
   `--type REGISTRY` + `--payload key=value …`. Do NOT invent
   `--server/--username/--password` flags; they do not exist and the command
   will fail silently or with an unhelpful error:
   ```bash
   osmo credential set nvcr --type REGISTRY \
     --payload registry=nvcr.io username='$oauthtoken' auth="$NGC_KEY"
   ```
   - `registry=` — hostname only (`nvcr.io`), no scheme, no path.
   - `username=` — literal string `$oauthtoken` for NGC (quote it in bash so
     the shell doesn't try to expand it).
   - `auth=` — **the raw NGC API key**. NOT `base64("$oauthtoken:$NGC_KEY")`.
     The Docker-style base64 auth string that lives in `~/.docker/config.json`
     will fail here with "Registry authentication failed". This is the single
     most common reason `osmo credential set` "doesn't work".

   Pick a short, descriptive name (`nvcr`, `nvcr-nvidian`, `nvcr_io`). The
   same name is what tasks reference in Step 4.

4. **Reference the credential from the workflow YAML** via the task-level
   `credentials:` map. The key is the credential name registered in Step 3;
   the value is either a mount path or an env-var mapping. OSMO auto-wires
   any REGISTRY-typed credential referenced this way as an `imagePullSecret`
   on the task pod:
   ```yaml
   workflow:
     tasks:
     - name: train
       image: nvcr.io/nvidia/pytorch:24.01-py3
       credentials:
         nvcr:                          # name must match the one registered above
           NGC_CLI_API_KEY: auth        # <ENV_VAR_NAME>: <payload_field_name>
   ```
   The credential name must match what Step 3 registered (case-sensitive,
   underscores vs hyphens matter — `nvcr_io` ≠ `nvcr-io`). Tasks without a
   matching credential fail with `ImagePullBackOff` /
   `unauthorized: authentication required`.

   **What the entry's value does.** The sub-map projects payload fields
   into the task container as env vars — `<ENV_VAR_NAME>: <payload_field>`.
   The LHS (`NGC_CLI_API_KEY`) is any env-var name you pick; the RHS
   (`auth`) MUST be a field name from the `--payload` you set in Step 3
   (valid RHS values for a REGISTRY credential: `registry`, `username`,
   `auth`). In the example above, `NGC_CLI_API_KEY=<raw NGC key>` is
   exported inside the task — useful when the task script itself calls NGC
   APIs or runs `docker login`. The REGISTRY credential is ALSO used
   automatically as the pod's `imagePullSecret` — that wiring happens just
   by referencing the credential name in `credentials:`, regardless of the
   env-var mapping.

   **Always include a sub-value.** Do NOT write `nvcr:` with a null/empty
   value — the spec requires either an env-var map (above) or a mount path
   (`<name>: <path>`). If you have no runtime need for the key inside the
   task, copy the harmless `NGC_CLI_API_KEY: auth` mapping — that's what
   every in-repo pipeline does. For the mount-path form and full
   `credentials:` schema, see `references/workflow-spec.md`.

5. **Verify end-to-end** by submitting a dry run or validate, then a real
   submit — if the registry credential is wrong, the task pod will be
   scheduled but stuck in `ImagePullBackOff`. Diagnose with:
   ```bash
   osmo workflow events <workflow_id>
   ```
   If you see `unauthorized` or `pull access denied`, the credential is
   missing, points at the wrong registry, or had base64 in `auth=`.

### Other credential types (short form)

The same `osmo credential set` command covers non-registry secrets. They are
not image-pull credentials but share the CLI shape:

```bash
# Generic bearer token (HF token, API keys referenced from task env)
osmo credential set hf-token --type GENERIC --payload token=hf_YOUR_TOKEN

# Data credential (object storage; also writes local config.yaml for the SDK)
osmo credential set my-s3 --type DATA --payload \
  access_key=... secret_key=... endpoint=... region=...
```

See `references/cli-commands.md` for full flag coverage and payload keys per
type.

### Not this skill

- **`docker login nvcr.io`** for host-side `docker run` / `docker pull` is
  a different mechanism (writes `~/.docker/config.json`, not an OSMO
  credential). That's a local-backend concern — not covered here.
- **Kubernetes `docker-registry` Secrets** created via `kubectl create secret
  docker-registry` are used by Physical AI install scripts (NIM, OSMO helm chart) to
  let the cluster itself pull images before any workflow runs. Those are
  separate from OSMO workflow credentials and live in the local OSMO /
  NIM Operator component install scripts.

---

## Quick Command Reference

For full flag coverage and edge cases, read `references/cli-commands.md`.

### Authentication

| Command | Purpose |
|---------|---------|
| `osmo login <url>` | Authenticate (methods: `code`, `password`, `token`, `dev`) |
| `osmo logout` | Clear stored credentials |
| `osmo version` | Show CLI version; also queries server version |

### Workflows

| Command | Purpose |
|---------|---------|
| `osmo workflow submit <file.yaml> --pool <pool>` | Submit a workflow |
| `osmo workflow submit <file.yaml> --pool <pool> --set key=value` | Submit with template overrides |
| `osmo workflow submit <file.yaml> --pool <pool> --dry-run` | Validate without submitting |
| `osmo workflow submit <file.yaml> --pool <pool> --priority LOW\|NORMAL\|HIGH` | Set priority |
| `osmo workflow validate <file.yaml> --pool <pool>` | Server-side validation only |
| `osmo workflow list` | List your workflows (add `--all-users` for all) |
| `osmo workflow query <id> --format-type json` | Detailed workflow status |
| `osmo workflow logs <id> --task <name> -n 1000` | Stream task logs |
| `osmo workflow events <id>` | Stream K8s events (useful for PENDING debugging) |
| `osmo workflow cancel <id> [<id2>...]` | Cancel workflows |
| `osmo workflow exec <id> <task>` | Shell into a running task |
| `osmo workflow spec <id> --template` | Print the original submitted spec |
| `osmo workflow port-forward <id> <task> --port 8080:80` | Forward local port to task |
| `osmo workflow restart <id>` | Restart a failed workflow |
| `osmo workflow rsync upload/download <id> ...` | Sync files into/out of a running task |

Invalid workflow forms: do not use status/tasks subcommands, command-root
pager flags, or positional task names for logs. Use `query`, `events`, `spec`,
and `logs --task <task>` instead.

### Resources & Pools

| Command | Purpose |
|---------|---------|
| `osmo pool list` | Show GPU quota and capacity per pool |
| `osmo pool list --mode free` | Show free GPUs instead of used |
| `osmo resource list -p <pool>` | List nodes and resources in a pool |
| `osmo resource info <node> -p <pool> -pl <platform>` | Node details |
| `osmo backend list` | List available backends |

### Datasets (OSMO-Managed)

| Command | Purpose |
|---------|---------|
| `osmo dataset upload <bucket/name:tag> <local_path>` | Upload a dataset |
| `osmo dataset download <name:tag> <local_path>` | Download a dataset |
| `osmo dataset list` | List datasets |
| `osmo dataset info <name>` | Dataset details and versions |
| `osmo dataset inspect <name:tag>` | Browse dataset contents |
| `osmo dataset delete <name:tag>` | Delete a dataset version |
| `osmo dataset collect <collection> <ds1> <ds2>` | Create a collection |
| `osmo dataset update <name:tag> --add src:dst` | Modify an existing dataset |
| `osmo dataset rename <old> <new>` | Rename a dataset |
| `osmo dataset tag <name:tag> --set <new_tag>` | Tag a dataset version |
| `osmo dataset label/metadata <name:tag> --set k=v` | Attach labels/metadata |

### Raw Data (Direct Storage)

| Command | Purpose |
|---------|---------|
| `osmo data upload <remote_uri> <local_path>` | Upload to S3/GCS/Swift/etc. |
| `osmo data download <remote_uri> <local_path>` | Download workflow data from storage |
| `osmo data list --no-pager <remote_uri>` | List objects at URI non-interactively |
| `osmo data delete <remote_uri>` | Delete objects |
| `osmo data check <remote_uri>` | Verify storage access |

### Apps (Reusable Workflow Templates)

| Command | Purpose |
|---------|---------|
| `osmo app create <name> -d "<desc>" -f <file.yaml>` | Create an app from YAML |
| `osmo app submit <name> --pool <pool> --set key=val` | Submit an app as workflow |
| `osmo app list` | List apps |
| `osmo app info <name>` | App details |
| `osmo app spec <name>` | Print app spec |
| `osmo app update <name> -f <file.yaml>` | Update app YAML (new version) |
| `osmo app delete <name[:version]>` | Delete an app or specific version |

### User & Profile

| Command | Purpose |
|---------|---------|
| `osmo profile list` | Show your profile, pools, and settings |
| `osmo profile set pool <pool>` | Set default pool |
| `osmo profile set bucket <bucket>` | Set default bucket |
| `osmo profile set notifications <bool>` | Toggle notifications |
| `osmo user list` | List users (admin) |

### Tokens & Credentials

| Command | Purpose |
|---------|---------|
| `osmo token set <name>` | Create a personal access token |
| `osmo token list` | List access tokens |
| `osmo token delete <name>` | Delete a token |
| `osmo credential set <name> --type REGISTRY\|DATA\|GENERIC` | Store a credential |
| `osmo credential list` | List stored credentials |
| `osmo credential delete <name>` | Remove a credential |

### Configuration (Admin)

In 6.3 ConfigMap mode (`services.configFile.enabled: true`), all configs live in the `osmo-service-configs` ConfigMap. The `osmo config` CLI subcommands no-op or 409 here.

| Command | Purpose |
|---------|---------|
| `kubectl get cm osmo-service-configs -n osmo-minimal -o yaml` | Show current config |
| `kubectl patch cm osmo-service-configs -n osmo-minimal --type=merge -p ...` | Apply a change (scripted, idempotent) |

The osmo-service container watches `/etc/osmo/configs/config.yaml` via inotify and reloads on change.

### Local Execution (No Cluster Required)

| Command | Purpose |
|---------|---------|
| `osmo standalone run -f <file.yaml>` | Run workflow locally via Docker (serial) |
| `osmo docker-compose run -f <file.yaml>` | Run workflow locally via Compose (parallel) |

Both support `--set`, `--credential NAME=PATH`, `--shm-size`, `--keep` (preserve
containers), `--resume`, and `--from-step <task>`. Use `docker-compose` when the
spec uses `{{host:taskname}}` (inter-task networking).

---

## Workflow Spec Quick Reference

For the complete schema (all fields, inputs, outputs, groups, credentials,
checkpoints, exit actions), read `references/workflow-spec.md`.

The minimum workflow YAML:

```yaml
workflow:
  name: my-workflow
  resources:
    default:
      cpu: 4
      gpu: 1
      memory: 16Gi
      storage: 50Gi
  tasks:
  - name: train
    image: nvcr.io/nvidia/pytorch:24.01-py3
    command: ["python", "train.py"]
```

### Key Concepts

- **`tasks:` vs `groups:`** — Mutually exclusive. Use `tasks:` for independent or serial
  workflows. Use `groups:` when tasks need to start together and communicate.
- **`{{output}}`** — Path where a task writes its output data.
- **`{{input:N}}`** — Path to the Nth upstream task's output (0-indexed).
- **`{{host:taskname}}`** — DNS name for another task in the same group.
- **`{{workflow_id}}`** — Unique workflow ID, set automatically.
- **`default-values:`** — Top-level block for Jinja template defaults.
- **`--set key=value`** — Override template variables at submit time.
- **Memory/storage units** — Must use binary units: `Gi`, `Mi` (never `GB`, `MB`).

### Data Flow Patterns

```yaml
# Task-to-task dependency
inputs:
- task: upstream_task_name

# Download from S3/cloud
inputs:
- url: s3://bucket/path/

# Upload output as dataset
outputs:
- dataset:
    name: my_output_dataset

# Upload output to URL
outputs:
- url: s3://bucket/output/
```

Fetch URL outputs with `osmo data list --no-pager <url>` and
`osmo data download <url> <local-path>`.

### Group Communication

```yaml
groups:
- name: training
  tasks:
  - name: server
    lead: true                    # required; group ends when lead exits
    image: my-image
    command: ["python", "server.py"]
  - name: worker
    image: my-image
    command: ["python", "worker.py", "--server={{host:server}}"]
```

For multi-task parallel/serial/pipeline patterns, read `references/workflow-patterns.md`.
For checkpointing, exit actions, and node exclusion, read `references/advanced-patterns.md`.

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OSMO_CONFIG_FILE_DIR` | Override config directory (default: `~/.config/osmo`) |
| `OSMO_LOG_FILE_DIR` | Override state/logs directory (default: `~/.local/state/osmo`) |
| `EDITOR` / `VISUAL` | Editor for interactive config/app editing |

The CLI does not use `OSMO_URL` or `OSMO_TOKEN` env vars; the URL and auth
tokens come from `login.yaml` written by `osmo login`.

---

## Architecture at a Glance

```text
CLI/UI → API Gateway → authz_sidecar (RBAC) → Core Service (FastAPI)
                                                  ├── PostgreSQL
                                                  ├── Redis (cache, jobs, events)
                                                  ├── Worker (job execution)
                                                  ├── Agent (K8s cluster events)
                                                  ├── Logger (log streaming)
                                                  └── Router (HTTP/WS routing)

Workflow execution:
  Core Service → K8s → [osmo_ctrl ↔ osmo_user ↔ osmo_rsync]
```

Each workflow runs three containers: **ctrl** (orchestrator), **user** (your
code), and **rsync** (data sidecar). The ctrl container manages data
download/upload and communicates with the service via WebSocket.
