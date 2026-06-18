# Deep Research Completion Validation

Use this reference when the user wants to verify that a deployed AI-Q research backend can complete a real deep research job. This is integration validation for deep research completion, not subjective report-quality scoring and not a skill-behavior test.

## Boundary

This validation checks:

- backend health and async agent API reachability
- `deep_researcher` availability
- explicit async `deep_researcher` submission
- polling to `completed` or `success`
- final report retrieval
- basic report/source structure
- absence of auth, provider, search, database, or report-generation errors

It does not validate data-source exhaustiveness, document ingestion, RAG ingestion, FRAG quality, or whether the final report is analytically strong. Those need separate test plans.

## When To Run

Run only after basic deploy validation passes and the user confirms. A deep research validation report commonly takes 7-20 minutes; observed report runs can land at the 20-minute mark with high token and tool-call usage. Use a timeout above the normal upper bound, such as 30 minutes.

A completed report may cite only a subset of sources it read. For example, an observed run cited 10 sources in the final report after reading 56 distinct URLs. This is not a failure by itself; report cited-source count and distinct URLs read separately when available.

## Prompt Strategy

Use a fixed prompt with deterministic assertions. Do not compare generated prose against a golden report as the primary signal; report wording is nondeterministic and will create noisy failures.

An example report can be useful as a schema reference for expected sections, citations, and artifact fields. Do not require exact phrasing, paragraph order, or analytical conclusions to match the example.

Use this validation prompt:

```text
Please create a short deep research report on Nvidia's cuda-x and how the different libraries relate to one another.
```

Passing means the deep research system completed and returned usable output, not that the report is the best possible answer.

## Suggested Sequence

1. Resolve `AIQ_SERVER_URL`; default to `http://localhost:8000` only when unset.
2. Run basic deploy validation if it has not already passed.
3. Confirm required secrets are present without printing values.
4. Confirm `deep_researcher` is available.
5. Submit the validation prompt as an explicit `deep_researcher` job.
6. Poll until the job reaches `completed` or `success`.
7. Fetch the final report and job state.
8. Summarize pass/fail by subsystem and hand the verified server URL back to `aiq-research`.
9. Include runtime, job ID, token count, tool-call count, cited-source count, and distinct URLs read when those values are available.

## API Checks

Use the `aiq-research` helper for API operations when available:

```bash
AIQ_SERVER_URL="${AIQ_SERVER_URL:-http://localhost:8000}"

AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py health
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py agents
```

The agent list must include `deep_researcher`. Then submit and poll an explicit deep research job:

```bash
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py research \
  "Please create a short deep research report on Nvidia's cuda-x and how the different libraries relate to one another." \
  deep_researcher
```

If the helper returns a `job_id` or polling is interrupted, keep the job ID in the validation summary and inspect status/state/report:

```bash
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py status "$JOB_ID"
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py state "$JOB_ID"
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py report "$JOB_ID"
```

Use SSE streaming only when debugging event delivery:

```bash
AIQ_SERVER_URL="$AIQ_SERVER_URL" python3 skills/aiq-research/scripts/aiq.py stream "$JOB_ID"
```

## Pass Criteria

Mark validation as passed only when these observable signals are present:

- backend health endpoint returns success
- async agents endpoint lists `deep_researcher`
- explicit `deep_researcher` job reaches `completed` or `success`
- final report endpoint returns non-empty report content
- job state or event store contains useful progress/artifact data
- report includes citations, source URLs, or source references
- cited-source count may be lower than the number of distinct URLs read
- no auth, model provider, search provider, database, or report-generation errors appear in status, state, logs, or returned content

## Failure Classification

| Symptom | Likely Area | Next Action |
|---|---|---|
| `/health` fails | deployment/runtime | return to basic validation and troubleshooting |
| agents endpoint fails | async API compatibility or backend route config | verify the deployed config exposes async jobs |
| `deep_researcher` is missing | backend config or API registry | verify the selected web config and server startup logs |
| submit fails | model endpoint, auth, route config, or job store | check required env keys and selected config |
| polling never completes | orchestration, worker, provider timeout, or search provider timeout | inspect job status, state, and backend logs |
| report endpoint is empty after success | report generation or persistence | inspect state artifacts and job storage |
| report has no citations or source references | search/source provider or report formatting | check provider env keys and source-tool logs |
| errors mention invalid key, unauthorized, or forbidden | secret/auth configuration | ask user to update keys without printing current values |
