# Evaluation Troubleshooting

The Evaluator plugin CLI surface is `nemo evaluator`.

## Quick Checks

```bash
nemo evaluator --help
nemo evaluator evaluate --help
nemo evaluator evaluate explain
```

## Local vs Cluster Runs

Use local execution to validate the spec:

```bash
nemo evaluator evaluate run --spec-file evaluation-spec.json
```

Use cluster submission once the same spec works locally:

```bash
nemo evaluator evaluate submit \
  --spec-file evaluation-spec.json \
  --workspace default \
  --profile default
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `No such command 'evaluation'` | The legacy generated CLI group was removed | Use `nemo evaluator ...` |
| Spec validation error | The submitted spec does not match the plugin schema | Run `nemo evaluator evaluate explain` and update the spec |
| Secret not found during `submit` | The judge metric references a missing NeMo platform secret | Run `nemo secrets list` in the target workspace and create the secret if needed |
| Local `run` cannot authenticate to the judge endpoint | `api_key_secret` points at a NeMo secret name instead of a local environment variable, or the environment variable is unset | Set the API key in the local environment and use that variable name as `api_key_secret`. See [Evaluator API Auth](api-auth.md) |
| Local run works but submit fails | Cluster/profile/workspace configuration issue | Check `nemo evaluator evaluate submit --help`, then retry with explicit `--workspace`, `--profile`, and cluster options |
