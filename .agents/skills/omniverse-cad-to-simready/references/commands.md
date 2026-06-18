# CAD to SimReady Command Patterns

Use the router and referenced installed reference scripts, not a single workflow
CLI. When `property_assignment_intent=run`, complete the Content Agents
readiness preflight before running the first local command below.

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/preflight/scripts/preflight.py \
  --env-file /path/to/output_dir/cad-to-simready-preflight.env \
  --report /path/to/output_dir/cad-to-simready-preflight.json \
  --markdown-report /path/to/output_dir/cad-to-simready-preflight.md

. /path/to/output_dir/cad-to-simready-preflight.env

python3 /path/to/skills/omniverse-cad-to-simready/references/convert-to-usd/scripts/run.py \
  /path/to/source_asset /path/to/output_dir/conversion \
  --report /path/to/output_dir/conversion.json

python3 /path/to/skills/omniverse-cad-to-simready/references/validate-usd-minimum/scripts/run.py \
  /path/to/output.usda \
  --report /path/to/output_dir/minimum-usd.json

python3 /path/to/skills/omniverse-cad-to-simready/references/content-agents/scripts/run.py \
  /path/to/output.usda \
  --output-dir /path/to/output_dir/assignment \
  --call material \
  --call physics \
  --prompt "$ASSET_CONTEXT_PROMPT" \
  --convert-output-to-usd \
  --report /path/to/output_dir/assignment/content-agents.json

python3 /path/to/skills/omniverse-cad-to-simready/references/simready-conform-profile/scripts/run.py \
  /path/to/output_dir/assignment/physics/output_physics.usd \
  --output-dir /path/to/output_dir/conform \
  --profile Prop-Robotics-Neutral \
  --pipeline-step material-agent-client \
  --pipeline-step physics-agent-client \
  --report /path/to/output_dir/conform/simready-conform-profile.json \
  --markdown-report /path/to/output_dir/conform/simready-conform-profile.md

python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate/scripts/run.py \
  /path/to/conformed_output.usd \
  --report /path/to/output_dir/asset-validator.json

python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate-geometry/scripts/run.py \
  /path/to/conformed_output.usd \
  --report /path/to/output_dir/geometry.json

python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate-physics/scripts/run.py \
  /path/to/conformed_output.usd \
  --report /path/to/output_dir/physics.json

python3 /path/to/skills/omniverse-cad-to-simready/references/simready-validate/scripts/run.py \
  /path/to/conformed_output.usd \
  --profile Prop-Robotics-Neutral \
  --report /path/to/output_dir/simready-profile.json

python3 /path/to/skills/omniverse-cad-to-simready/references/ovrtx-render-service/scripts/run.py \
  /path/to/conformed_output.usd \
  /path/to/output_root/pipeline/06_render/thumbnail.png \
  --report /path/to/output_root/pipeline/06_render/ovrtx-render-service.json \
  --markdown-report /path/to/output_root/pipeline/06_render/ovrtx-render-service.md

python3 /path/to/skills/omniverse-cad-to-simready/references/assemble-package-source/scripts/run.py \
  /path/to/conformed_output.usd \
  /path/to/output_root \
  --asset-name asset_name \
  --thumbnail /path/to/output_root/pipeline/06_render/thumbnail.png \
  --report /path/to/output_root/pipeline/assembly-report.json

python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample/scripts/run.py \
  /path/to/output_root/deliverable \
  --name asset_name \
  --version 1.0.0 \
  --license LicenseRef-Proprietary \
  --root-usd simready_usd/sm_asset_name_01.usd \
  --report /path/to/output_root/pipeline/07_package/package-create.json

python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample-validation/scripts/run.py \
  /path/to/output_root/deliverable/com.nvidia.simready.packaging.json \
  --report /path/to/output_root/pipeline/07_package/package-validation.json
```

Treat FET000, FET001, FET004, and FET005 as lower-level upstream skills
selected by `simready-conform-profile`. Use the concrete `output_usd_path` from
the Content Agents report as conformance input, then use the concrete
`output_usd_path` from the conformance report as `/path/to/conformed_output.usd`
for validation, rendering, and packaging. When property assignment will run, do
not call FET001 or any other FET helper before Content Agents. Run the FET001
flow only in the post-assignment conformance pass when the latest
service-authored USD has `metersPerUnit != 1.0` or validation reports `UN.007`.
The FET005 helper requires explicit visually selected points; do not invent
them from a placeholder command.

Use each assignment report's concrete `output_usd_path` instead of assuming the
placeholder filenames in these examples.

For package creation, keep `pipeline/` and `deliverable/` separate. Reports,
intermediate USDs, assignment outputs, and validation JSON stay under
`pipeline/`. The only folder passed to `nv-core-package-sample` is the clean
`deliverable/` directory produced by `assemble-package-source`.

For conversion-only or validation-only work, run preflight with
`--skip-content-agents`. Preflight prepares dependencies only; downstream
converter references decide source support. For hosts where
Content Agents endpoints are provided but services must not be started, use
`--skip-deploy` and keep `CONTENT_AGENTS_*_BASE_URL` / renderer endpoint
variables in the environment before running preflight.
