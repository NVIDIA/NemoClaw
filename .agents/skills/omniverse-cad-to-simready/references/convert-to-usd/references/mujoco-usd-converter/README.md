# Convert MuJoCo to USD

## When to Use

Use this reference for MuJoCo XML (MJCF)-to-OpenUSD conversion. The intended converter is `newton-physics/mujoco-usd-converter`, distributed as the `mujoco-usd-converter` Python package and the `mujoco_usd_converter` CLI.

The converter creates a standalone, self-contained OpenUSD artifact from an MJCF file and referenced OBJ/STL assets. It supports visual geometry, materials, bodies, collision geometry, sites, joints, actuators, UsdPhysics data, and MuJoCo-specific MjcPhysics schemas.

## Inputs

Require:

- a source `.xml` or `.mjcf` file with MuJoCo content
- an output directory for the USD artifact

Collect when present:

- mesh and texture asset directories referenced by the MJCF
- included MJCF files or model directories
- target runtime intent, such as MuJoCo, Newton, Isaac/PhysX, or profile validation

## Dependency Check

Before conversion, confirm the installed reference dependency check passes:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

This reference wraps the external `mujoco_usd_converter` CLI. If conversion reports the external CLI as missing, check whether the dependency is installed:

```bash
mujoco_usd_converter --help
```

If neither is available, stop and report the missing dependency. Do not install packages unless the user has approved dependency installation.

## Format Detection

Do not treat every XML-like file as MJCF based on suffix alone. Inspect the file and require MuJoCo evidence such as:

- `<mujoco>` root element
- `<worldbody>`, `<body>`, `<joint>`, `<actuator>`, or `<asset>` sections in MuJoCo layout
- user context that explicitly identifies the file as MuJoCo XML (MJCF)

If an XML or MJCF file is ambiguous, route back through `convert-to-usd` or ask for clarification.

## Conversion Workflow

1. Inspect the MJCF for meshes, textures, included files, bodies, joints, actuators, and collision definitions.
2. Resolve relative asset paths from the MJCF directory.
3. Confirm the converter dependency is available.
4. Run conversion into a clean output directory.
5. Identify the primary USD artifact returned by the converter or created in the output directory.
6. Record warnings for unresolved assets, unsupported MJCF features, or runtime-specific physics concerns.
7. Hand off the generated USD artifact to `validate-usd-minimum`.

## CLI Pattern

Prefer the installed reference-local script after confirming dependencies:

```bash
python3 scripts/run.py /path/to/robot.xml /path/to/usd_robot --report /path/to/conversion_report.json
```

The wrapper preserves the normalized skill-hub report and forwards supported
upstream `mujoco_usd_converter` options verbatim. Use the upstream flag names
for single-file output, physics-scene omission, verbose conversion, or authored
comments:

```bash
python3 scripts/run.py /path/to/robot.xml /path/to/usd_robot \
  --no-layer-structure \
  --no-physics-scene \
  --verbose \
  --comment "Converted for validation"
```

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/convert-to-usd/references/mujoco-usd-converter/scripts/run.py /path/to/robot.xml /path/to/usd_robot --report /path/to/conversion_report.json
```

Open `report.output_usd_path` with USD tooling when a post-conversion check is needed.

## Output Format

Report:

- source MJCF path
- output directory
- primary USD artifact path
- converter package and CLI/API used
- referenced mesh and texture counts when easy to determine
- included files or asset directories
- unresolved references
- warnings and errors
- recommended next validation skill: `validate-usd-minimum`

## Known Caveats

The converter is described by its maintainers as alpha. Its output may use nested rigid bodies and MuJoCo-specific MjcPhysics schemas. That can be faithful to MuJoCo/Newton-style reduced-coordinate simulation but may not import cleanly into every UsdPhysics runtime. Record those runtime compatibility concerns for later `omni-asset-validate-physics` and `simready-validate` stages.
