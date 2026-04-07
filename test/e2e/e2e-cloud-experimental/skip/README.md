# Opt-in checks (`skip/`)

Scripts here are **not** picked up by `test/e2e/test-e2e-cloud-experimental.sh` (only `checks/*.sh` runs in Phase 5).

Use when a check is useful but flaky, slow, or environment-specific — run manually:

```bash
export SANDBOX_NAME=…
bash test/e2e/e2e-cloud-experimental/skip/05-network-policy.sh
```
