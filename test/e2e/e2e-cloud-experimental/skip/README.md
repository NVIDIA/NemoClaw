# Opt-in checks (`skip/`)

Scripts here are not part of the default E2E flow.

Use when a check is useful but flaky, slow, or environment-specific — run manually:

```bash
export SANDBOX_NAME=…
bash test/e2e/e2e-cloud-experimental/skip/05-network-policy.sh
```
