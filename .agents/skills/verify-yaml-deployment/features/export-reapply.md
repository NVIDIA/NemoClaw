<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Export and Unchanged Reapply

After apply, the author can export the deployment back to YAML without secret values, including the service exposure.
Reapplying the export changes nothing, so the authored YAML stays the source of truth.

## Sub-features

- **EX1:** `nemoclaw export` writes the deployment, with `serviceExposures`, `interfaces`, and the credential reference, and no secret value.
- **EX2:** The exported document plans with no changes; applying it reports no resource changes, keeps the same sandbox and runtime, and lists the same **Service URLs** and **Agent interfaces** as the first apply.

## How to get to it (user POV)

- `nemoclaw export --state-dir PATH` and `nemoclaw apply`, as [usage.md](../../../../docs/build-deploy/usage.md#verify-an-unchanged-reapply) documents.

## Driving it with the nemoclaw CLI

Preconditions: the launch applied, and [deploy-and-answer](deploy-and-answer.md)'s DA1 passed.

1. **EX1:**
   ```sh
   nc export --output "$EVIDENCE/exported.yaml" 2> "$EVIDENCE/export.err"; echo "export-exit=$?"
   grep -A3 -E 'serviceExposures:|interfaces:' "$EVIDENCE/exported.yaml"
   [ -z "$PROVIDER_KEY_ENV" ] || grep -c "env: $PROVIDER_KEY_ENV" "$EVIDENCE/exported.yaml"
   [ -z "$PROVIDER_KEY_ENV" ] || grep -cF "$(printenv "$PROVIDER_KEY_ENV")" "$EVIDENCE/exported.yaml"
   ```
   Result: `export-exit=0`; any exposures and interfaces the YAML declares; then `1`, then `0`.
   `--output` leaves an existing file alone when export fails; a shell redirect would truncate it.
2. **EX2:**
   ```sh
   nc plan "$EVIDENCE/exported.yaml" --progress off > "$EVIDENCE/reapply-plan.txt" 2>&1
   grep -c 'No resource changes planned.' "$EVIDENCE/reapply-plan.txt"
   SANDBOX_BEFORE=$SANDBOX_CONTAINER
   RUNTIME_BEFORE=$(jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate")
   nc apply "$EVIDENCE/exported.yaml" --progress off > "$EVIDENCE/reapply.txt" 2>&1
   grep -c 'No resource changes.' "$EVIDENCE/reapply.txt"
   docker ps --format '{{.Names}}' | grep -cx "$SANDBOX_BEFORE"
   jq -r '.resources[] | select(.type == "fabric_agent") | .instances[].attributes | select(.name == "assistant") | .runtime_id' "$STATE/terraform.tfstate" | grep -cx "$RUNTIME_BEFORE"
   for f in apply reapply; do
     sed -n '/^Service URLs:/,/^$/p' "$EVIDENCE/$f.txt" > "$RUN_DIR/urls-$f.txt"
     sed -n '/^Agent interfaces:/,/^$/p' "$EVIDENCE/$f.txt" > "$RUN_DIR/interfaces-$f.txt"
   done
   diff "$RUN_DIR/urls-apply.txt" "$RUN_DIR/urls-reapply.txt" && echo same-urls
   diff "$RUN_DIR/interfaces-apply.txt" "$RUN_DIR/interfaces-reapply.txt" && echo same-interfaces
   nc apply "$EVIDENCE/exported.yaml" --progress off -o json 2> /dev/null | jq -c '{changes: (.changes | length), serviceUrls, warnings}' | tee "$EVIDENCE/reapply-json.txt"
   ```
   Result: four counts of `1`, then `same-urls` and `same-interfaces`, then `changes: 0` with the same URLs under `serviceUrls` and no `warnings`.
   A deployment without exposures or interfaces prints neither section and has `serviceUrls: null`; the diffs are empty and still pass.

## Gotchas

- Export stops on drift, such as an exposure deleted with `openshell service delete`; that is correct, so don't change the gateway by hand before this feature.
- Export drops comments and may reorder keys; compare meaning, not text.
- For `export`, `-o` names the output file, not a format: `-o json` writes a file named `json`.
