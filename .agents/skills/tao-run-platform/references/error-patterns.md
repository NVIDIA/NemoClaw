# SDK error patterns

Read this file when the agent hits an SDK error — the entries map exception
text or status conditions to root cause and fix.

**`CredentialError: Missing LEPTON_WORKSPACE_ID`**: env var not loaded. Run `source ~/.config/tao/.env` or check the SessionStart hook fired.

**`CredentialError: S3_BUCKET_NAME env var required`**: any `inputs` or `outputs` argument needs S3 credentials. Set `S3_BUCKET_NAME`, `ACCESS_KEY`, `SECRET_KEY` (and `S3_ENDPOINT_URL` for non-AWS).

**TAO crash: `You need to set ... results_dir`** (or any spec key declared in `skill_info.actions.<action>.outputs`): `build_entrypoint` was called without `outputs=action_cfg["outputs"]`. The script_runner only auto-fills output spec keys it was told about; missing `outputs=` leaves `results_dir: ''` and the TAO entrypoint aborts. Same root cause if S3 input URIs aren't downloaded — `inputs=action_cfg["inputs"]` was also omitted. Mirror both from `skill_info.yaml` exactly.

**Job stuck in `Pending` (Lepton)**: call `get_job_replicas(job_id)` and inspect `readiness_issue`. Most common: image pull (waited too long) or `ConfigError` on a bad node — cancel and resubmit.

**`Image pull failed`**: `NGC_KEY` is invalid or expired. The SDK auto-creates a Lepton image-pull-secret from `$NGC_KEY`; refresh the key and resubmit.

**Double slash in S3 URI**: `dataset_uri.rstrip("/")` before concatenating, or use `os.path.join` (note: not `posixpath.join` — that doesn't strip).

**Brev instance won't start**: GPU type unavailable in the user's region. Try a different `gpu_type` or wait.
