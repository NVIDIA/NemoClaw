<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Export and Unchanged Reapply

After apply, the author can export the deployment back to YAML without secret values, including the service exposure.
Reapplying the export changes nothing, so the authored YAML stays the source of truth.

## Sub-features

- **EX1:** `nemoclaw export` prints the deployment, with `serviceExposures` and the credential reference, and no secret value.
- **EX2:** Applying the exported document reports no resource changes, keeps the same sandbox, and lists the same service URLs as the first apply.

## How to get to it (user POV)

- `nemoclaw export --state-dir PATH` and `nemoclaw apply`, as [usage.md](../../../../docs/usage.md#verify-an-unchanged-reapply) documents.

## Driving it with the nemoclaw CLI

Preconditions: the launch applied, and [deploy-and-answer](deploy-and-answer.md)'s DA1 passed.

1. **EX1:**
   ```sh
   nc export > "$EVIDENCE/exported.yaml" 2> "$EVIDENCE/export.err"
   grep -A3 'serviceExposures:' "$EVIDENCE/exported.yaml"
   [ -z "$PROVIDER_KEY_ENV" ] || grep -c "env: $PROVIDER_KEY_ENV" "$EVIDENCE/exported.yaml"
   [ -z "$PROVIDER_KEY_ENV" ] || grep -cF "$(printenv "$PROVIDER_KEY_ENV")" "$EVIDENCE/exported.yaml"
   ```
   Result: any exposures the YAML declares, then `1`, then `0`.
2. **EX2:**
   ```sh
   SANDBOX_BEFORE=$SANDBOX_CONTAINER
   nc apply "$EVIDENCE/exported.yaml" --progress off > "$EVIDENCE/reapply.txt" 2>&1
   grep -c 'No resource changes.' "$EVIDENCE/reapply.txt"
   docker ps --format '{{.Names}}' | grep -cx "$SANDBOX_BEFORE"
   sed -n '/^Service URLs:/,/^$/p' "$EVIDENCE/apply.txt" > "$RUN_DIR/urls-first.txt"
   sed -n '/^Service URLs:/,/^$/p' "$EVIDENCE/reapply.txt" > "$RUN_DIR/urls-reapply.txt"
   diff "$RUN_DIR/urls-first.txt" "$RUN_DIR/urls-reapply.txt" && echo same-urls
   nc apply "$EVIDENCE/exported.yaml" --progress off -o json 2> /dev/null | jq -c '{changes: (.changes | length), serviceUrls, warnings}' | tee "$EVIDENCE/reapply-json.txt"
   ```
   Result: both counts are `1`, then `same-urls`, then `changes: 0` with the same URLs under `serviceUrls` and no `warnings`.
   A deployment without exposures prints no **Service URLs** section and no `serviceUrls` field, so the diff is empty and still passes.

## Gotchas

- Export stops on drift, such as an exposure deleted with `openshell service delete`; that is correct, so don't change the gateway by hand before this feature.
- Export drops comments and may reorder keys; compare meaning, not text.
