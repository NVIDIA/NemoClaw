# SimReady Package Asset

## When to Use

Use this reference when the user wants to turn a clean, self-contained folder of
USD files into a SimReady package. For CAD-to-SimReady workflow outputs, create
that folder first with `assemble-package-source` and pass
`{output_root}/deliverable` here. This is a packaging workflow skill, not a CAD
conversion workflow. It runs the SimReady package phases explicitly:

```text
source folder
-> pre-validation
-> create package definition and metadata
-> post-validation
-> report package result
```

The installed reference entrypoint is `scripts/run.py`. It creates `com.nvidia.simready.packaging.json`, `.metadata/com.nvidia.simready.packaging.bom.json`, `.metadata/com.nvidia.simready.root_usds.json`, and a package report for the local backend.

## Upstream Reference

The team reference workflow is NVIDIA's SimReady Foundation create-package skill:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-create-package/SKILL.md
```

Access note: Browser or raw-file fetches of the upstream skill URL can fail in restricted environments. If that happens, use a local clone of `https://github.com/NVIDIA/simready-foundation` on branch `main` and read `skills/simready-foundation-create-package/SKILL.md` from that checkout. Prefer `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation` or `$HOME/.physical-ai-skill-hub/upstreams/simready-foundation`.

Use that upstream skill as the source of truth for the packaging flow. It drives `assets/scripts/create_simready_package.py`, which performs pre-validation, package creation, and post-validation in one command. Do not duplicate or reinterpret the upstream package workflow inside this reference; point to the upstream skill and run the upstream sample when formal packaging is required. In an installed reference, use `scripts/run.py --backend wrapp --upstream-scripts-dir /path/to/simready-foundation/skills/simready-foundation-create-package/assets/scripts` when the user has a local checkout and WRAPP runtime.

## Dependencies

Require:

| Backend | Runtime |
|---|---|
| `local` | this reference's portable `scripts/run.py`, OpenUSD Python APIs through `pxr.Usd` and `pxr.Sdf` |
| `wrapp` | local checkout of `skills/simready-foundation-create-package/assets/scripts`, `simready-validate`, `omni-wrapp-minimal[local]`, and the upstream `create_simready_package.py` workflow |

Do not silently fall back from `wrapp` to `local`. If the user asked for WRAPP publishing and the upstream sample or WRAPP dependencies are missing, report the blocked dependency and the exact missing input.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `source` | Required clean package source folder. For CAD-to-SimReady outputs, use `{output_root}/deliverable`, not the workflow output root or `pipeline/`. For the local backend, this folder becomes the package root. |
| `name` | Required package name, such as `apple_a01` or `minimal_package`. |
| `version` | Required package version; default to `1.0.0` only when the user has not specified one. |
| `license` | Required SPDX license identifier or `LicenseRef-*`; do not invent a license for a user's asset. |
| `root_usd` | Required root USD path relative to `source`; repeat when the package has multiple entry points. |
| `repo` | Required only for `--backend wrapp`. |
| `upstream_scripts_dir` | Required only for `--backend wrapp`; must point at `skills/simready-foundation-create-package/assets/scripts`. The legacy `--upstream-sample-dir` flag is still accepted for older local checkouts. |

Ask before overwriting an existing package definition unless the user explicitly requested overwrite.

## Instructions

1. Confirm the source folder exists.
2. Confirm at least one root USD entry point is known.
3. Run pre-validation against the source folder: root USD metadata, root USD openability, anchored asset paths, package self-containment, and referenced file types.
4. For the local backend, write package metadata and `com.nvidia.simready.packaging.json`.
5. For the WRAPP backend, call the upstream `create_simready_package.py` through this reference's `scripts/run.py --backend wrapp`.
6. Run post-validation with `nv-core-package-sample-validation` unless the user explicitly asks to skip it.
7. Preserve the JSON report and summarize every phase as pass, fail, or blocked.

## CLI Pattern

Local package creation:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample/scripts/run.py /path/to/source \
  --name minimal_package \
  --version 1.0.0 \
  --license MIT \
  --root-usd simready_usd/sm_minimal_package_01.usda \
  --report /path/to/package-report.json
```

WRAPP-backed publishing through the upstream sample:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample/scripts/run.py /path/to/source \
  --backend wrapp \
  --upstream-scripts-dir "$HOME/.physical-ai-skill-hub/upstreams/simready-foundation/skills/simready-foundation-create-package/assets/scripts" \
  --repo /path/to/repo \
  --name apple_a01 \
  --version 1.0.0 \
  --license Apache-2.0 \
  --root-usd sm_apple_a01_01.usd \
  --report /path/to/package-report.json
```

Do not use this command to convert CAD, URDF, MuJoCo, OBJ, DAE, or STL inputs. Convert to USD first with `convert-to-usd`.

## Output Format

The report includes:

- `package_root`
- `package_definition_path`
- `skill`
- `tool`
- `operation`
- `backend`
- `profile`
- `passed`
- `status`
- `checks`
- `phases`
- `metadata`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail when:

- the source folder is missing
- root USD entries are missing, malformed, duplicated, missing on disk, or cannot be opened
- asset references are absolute, search-path based, escape the package root, or point to missing files
- package definition required fields are invalid
- metadata entries, BOM entries, content hashes, package hashes, or root-USD metadata are invalid
- the upstream WRAPP workflow fails

Warn when package content includes files outside the current MVP supported type set but those files are not referenced by USD layers.

## Next Steps

Use `nv-core-package-sample-validation` to re-check a finished package definition. Use future publishing or repository upload skills after the package has passed post-validation.
