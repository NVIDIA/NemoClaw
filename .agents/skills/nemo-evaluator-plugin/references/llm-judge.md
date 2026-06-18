# LLM Judge Notes

Use `nemo evaluator evaluate explain` to inspect the current Evaluator plugin spec schema before creating an LLM-judge run.

When configuring an LLM judge, verify:

1. The judge model authentication reference matches the execution mode. See [Evaluator API Auth](api-auth.md).

2. The judge model name is the API model ID expected by the endpoint, not an entity display name.

3. The metric prompt and parser match the output you expect from the judge model.

For local iteration, keep the metric and dataset in a spec file and run:

```bash
nemo evaluator evaluate run --spec-file evaluation-spec.json
```

The checked-in `skills/nemo-evaluator-plugin/assets/specs/llm_as_judge.json` is a local-run example. It expects `NVIDIA_API_KEY` to be set in the local shell.

For durable execution, submit the same spec:

```bash
nemo evaluator evaluate submit \
  --spec-file evaluation-spec.json \
  --workspace default \
  --profile default
```

Before submitting an LLM-judge spec via `submit`, replace local environment-variable names with platform secret names, such as `nvidia-api-key`.

Prefer `--spec-file` over inline `--spec` for LLM-judge metrics because prompts and score definitions quickly become hard to audit as shell-escaped JSON.
