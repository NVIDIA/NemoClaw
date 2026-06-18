# NVCF Inference

> **Source docs:** https://docs.nvidia.com/cloud-functions/

## Capability catalog

Match pipeline needs against this table and export the `*_URL` env vars in Step 4.

| Function | Env var | Capabilities | Notes |
|----------|---------|--------------|-------|
| Nurec (Llama 3.1 8B Instruct) | `LLAMA31_8B_URL` / function ID | `text-llm`, `chat` | OpenAI-compat `/v1/chat/completions` |
| Cosmo (Cosmos Predict 1) | `COSMOS_PREDICT1_URL` / function ID | `video-world-model`, `video-generation` | Used by Augmentation |
| Cosmos Transfer 2.5 | `COSMOS_TRANSFER25_URL` | `video-style-transfer` | Optional |
| Qwen2.5 14B | `QWEN25_14B_URL` | `text-llm`, `chat` | Alternative text LLM |
| Qwen3 VL 30B | `QWEN3_VL_30B_URL` | `vlm`, `video-qa`, `chat` | Alternative VLM |

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Brev org | Access to a Brev org whose linked NGC Org has Nurec/Cosmo provisioned |
| NGC Org API key | One key per Brev org — obtain from NGC portal |
| `curl` | For endpoint validation |

## Supporting files

| Path | Use | When |
|------|-----|------|
| `scripts/preflight.sh` | Run first | Checks local tools, loads repo `.env`, validates `NGC_API_KEY`, and probes NVCF unless network checks are skipped. |

## Setup

Brev org → NGC org is 1:1. One Org API key authenticates NVCF, `nvcr.io` pulls, and the NGC CLI.

1. Get the **Org-level** NGC API key. If `NGC_API_KEY` is not in `.env`, prompt the user with these links (do NOT hardcode org IDs):
   - Brev orgs list: <https://brev.nvidia.com/org> — ask the user which Brev org they're deploying into if not obvious.
   - NGC API keys: <https://ngc.nvidia.com/setup/api-keys> — **Generate Org API Key** (NOT a personal Legacy API Key). The NGC org shown must match the user's Brev org.

2. Persist in repo-root `.env`:
   ```bash
   NGC_API_KEY=<your-ngc-org-api-key>
   ```

3. Verify:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     -H "Authorization: Bearer ${NGC_API_KEY}" \
     https://api.nvcf.nvidia.com/v2/nvcf/functions
   ```
   Expect `200`.

4. List deployed functions and pick the ones the pipeline needs:
   ```bash
   curl -s -H "Authorization: Bearer ${NGC_API_KEY}" \
     https://api.nvcf.nvidia.com/v2/nvcf/functions \
     | jq '.functions[] | {name, id, status}'
   ```

5. Export the matching `*_URL` env vars (from the catalog above) to repo-root `.env`. The URL format is `https://api.nvcf.nvidia.com/v2/nvc/functions/<function-id>/versions/<version-id>` — copy from the NVCF portal or derive from the list output.

### Rotate the key

Replace `NGC_API_KEY` in `.env` and re-run every consuming stage's install script so pull secrets get recreated in each namespace.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Wrong key type (personal vs org) | Use the Org-level API key, not a personal token |
| `403 Forbidden` | Key not associated with correct NGC org | Verify org in NGC portal matches Brev org |
| Functions list empty | No functions deployed to org | Ask the NVCF function owner for your NGC org to provision Nurec/Cosmo |
| Image pull fails from nvcr.io | `nvcr-pull-secret` missing/stale | Re-run Step 2 to recreate the secret |
