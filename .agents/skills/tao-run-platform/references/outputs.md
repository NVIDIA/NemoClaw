# Output Destinations and Spec Shape

## Where outputs go (resolved at runtime — agents don't manage it)

The SDK injects `TAO_JOB_ID` (matches `Job.id`) and, when a persistent mount is attached, `TAO_RESULTS_ROOT` into the container env. Inside the container, `script_runner` resolves output destinations:

| Container env | Result |
|---|---|
| `TAO_RESULTS_ROOT` set (Lustre / PVC / bind / NFS) | Outputs at `{TAO_RESULTS_ROOT}/<job_id>/<key>/`; no upload |
| `S3_BUCKET_NAME` set (cloud, no mount) | Outputs at `s3://{bucket}/results/<job_id>/<key>/`; uploaded at end of run |
| Neither | Outputs at `/results/<job_id>/<key>/` (container-ephemeral) with a loud end-of-run warning |

Per-platform policy:

| SDK | What gets injected |
|---|---|
| `SlurmSDK` | `TAO_RESULTS_ROOT={SLURM_BASE_RESULTS_DIR}/results` (always — Lustre, never S3, avoids GPU-idle scheduler kill) |
| `LeptonSDK` | `TAO_RESULTS_ROOT={mount}/results` if a workspace volume is attached; otherwise S3 fallback |
| `KubernetesSDK` / `DockerSDK` / `BrevSDK` | `TAO_RESULTS_ROOT=/results` if a mount targets `/results`; otherwise S3 fallback |

Agents who want a custom destination can put an `s3://...` URI or absolute path directly at the output spec key — explicit values override the auto-fill. Otherwise, model-natural defaults like cosmos-rl's `output_dir: "output"` or DINO's empty `results_dir` are auto-rewritten by `script_runner`.

## The spec is nested dicts, NOT flat dotted keys

This is the most common mistake when constructing a spec. The dotted notation that appears in `skill_info.yaml`'s `inputs:` / `outputs:` blocks (e.g. `section.subsection.key`) is a **path into** a nested spec — `script_runner` looks values up at that path. It's not the spec's own shape. The spec mirrors whatever shape the model's container expects (typically a nested TOML/YAML).

```python
# ✓ CORRECT — nested dicts
specs = {
    "section": {
        "subsection": {"key": "value"},
    },
}

# ✗ WRONG — flat top-level key with dots. TOML/YAML emits this as a
# quoted bare-string key, the model sees an empty `section` table, and
# any input declared at "section.subsection.key" silently fails to
# download because _get_nested(specs, "section.subsection.key") → None.
specs = {
    "section.subsection.key": "value",
}
```

The two shapes look superficially similar but mean different things. When in doubt, open the model's `references/` directory (e.g. a default-spec TOML or YAML) — that's the literal nested structure the spec dict needs to mirror. The `inputs:` / `outputs:` declarations in `skill_info.yaml` are *paths into* the nested spec, not key names.
