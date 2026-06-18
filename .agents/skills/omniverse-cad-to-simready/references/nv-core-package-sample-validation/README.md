# SimReady Validate Package

## When to Use

Use this validation-only skill when the user wants to validate an existing SimReady package definition. The expected input is `com.nvidia.simready.packaging.json` at the package root.

This reference does not convert source assets, repair USD layers, or publish packages. Use `nv-core-package-sample` when package creation is requested.

## Upstream Reference

The team reference workflow is NVIDIA's SimReady Foundation create-package skill:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-create-package/SKILL.md
```

Access note: Browser or raw-file fetches of the upstream skill URL can fail in restricted environments. If that happens, use a local clone of `https://github.com/NVIDIA/simready-foundation` on branch `main` and read `skills/simready-foundation-create-package/SKILL.md` from that checkout. Prefer `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation` or `$HOME/.physical-ai-skill-hub/upstreams/simready-foundation`.

For formal package post-validation with the registered SimReady Foundation package profiles, use the upstream `create_simready_package.py --only-post-validation` flow from that sample when `simready-validate` and WRAPP dependencies are installed. Do not duplicate or reinterpret the upstream package validation workflow inside this reference; point to the upstream skill and run the upstream sample when formal validation is required. This installed reference's `scripts/run.py` provides deterministic package checks for local package artifacts.

## Dependency Check

Require:

- this reference's portable `scripts/run.py` and `scripts/check_dependencies.py`
- OpenUSD Python APIs through `pxr.Usd` and `pxr.Sdf`

Formal upstream package validation additionally requires the SimReady Foundation `skills/simready-foundation-create-package/assets/scripts` environment with `simready-validate` and `omniverse-asset-validator` package-profile registration.

## Package Checks

The installed validator script checks:

| Area | Requirement family |
|---|---|
| Package definition | `PKG.DEF.001` canonical file name, JSON object, `format_version`, `package_id`, `license`, metadata entries |
| Metadata files | `PKG.META.001` `.metadata/` files are JSON, named with reverse-domain style, and hash-matched when registered |
| BOM | `PKG.BOM.001` BOM exists for `Package`, has unique forward-slash relative paths, matching sizes, matching hashes, and complete content inventory |
| Root USDs | `PKG.CONF.002` root USD metadata exists when available, entries are unique relative paths, and roots open as USD stages |
| Atomic asset paths | `AA.001` asset references are anchored and remain inside the package root |
| Supported referenced types | `AA.002` referenced assets use supported USD, image, or audio extensions |
| Hashes | `PKG.HASH.001` content and package hashes match when present |

## Instructions

1. Confirm the package definition exists and is named `com.nvidia.simready.packaging.json`.
2. Parse the package definition JSON.
3. Validate required package definition fields and metadata entry structure.
4. Validate registered metadata files under `.metadata/`.
5. Validate BOM structure, hashes, and completeness for `--profile Package`.
6. Validate root USD metadata when present.
7. Open root USD stages and inspect authored asset references for package self-containment.
8. Return a structured pass/fail report.

## CLI Pattern

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample-validation/scripts/run.py /path/to/com.nvidia.simready.packaging.json --report /path/to/package-validation.json
python3 /path/to/skills/omniverse-cad-to-simready/references/nv-core-package-sample-validation/scripts/run.py /path/to/com.nvidia.simready.packaging.json --profile Package-NoBOM --report /path/to/package-validation.json
```

Use `Package` for BOM-bearing packages. Use `Package-NoBOM` only for lightweight packages that intentionally do not include BOM metadata.

## Output Format

Reports include:

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
- `metadata`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail when:

- the package definition is missing, misnamed, malformed, or lacks required fields
- required package metadata is missing for the selected profile
- metadata entries point to missing files or hash mismatches
- the BOM is missing for `Package`, incomplete, duplicated, malformed, or hash-mismatched
- root USD entries are malformed, missing, or cannot be opened
- USD asset references are non-anchored, escape the package root, use unsupported referenced file types, or point to missing files
- `content_hash` or `package_hash` is present but mismatched

Warn when:

- `Package-NoBOM` is selected and `.metadata/` or BOM files are absent
- root USD metadata is absent and the validator has to discover USD files
- non-referenced package sidecar files are outside the current MVP supported type set

## Next Steps

After validation passes, the package can be consumed locally or handed to a future repository publishing skill. After validation fails, fix the first failing package requirement before retrying.
