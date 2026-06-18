# Evaluator API Auth

Use the correct `model.api_key_secret` (if `model` is used) for the evaluator execution mode:

- Local `nemo evaluator evaluate run`: `api_key_secret` is the name of an environment variable available to the local process, such as `NVIDIA_API_KEY`.
- Remote `nemo evaluator evaluate submit`: `api_key_secret` is the name of a NeMo platform secret in the target workspace, such as `nvidia-api-key`.

The remote job runtime cannot read local environment variables. In remote mode, if a model sets `api_key_secret`, create or verify the platform secret before submitting the job:

```bash
printf '%s' "$NVIDIA_API_KEY" | nemo secrets create nvidia-api-key --from-file -
nemo secrets list
```

If you copy a local LLM-judge spec that uses `"api_key_secret": "NVIDIA_API_KEY"` for remote submission, change that value to the platform secret name, for example `"nvidia-api-key"`.
