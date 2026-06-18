# Convert URDF to USD

## When to Use

Use this reference for URDF-to-OpenUSD conversion. The intended converter is `newton-physics/urdf-usd-converter`, distributed as the `urdf-usd-converter` Python package and the `urdf_usd_converter` CLI.

The converter creates a standalone, self-contained OpenUSD artifact from a URDF file and referenced mesh files in OBJ, DAE, and STL format, plus texture data. It supports visual geometry, materials, links, collision geometry, and joints needed for kinematic simulation.

## Inputs

Require:

- a source `.urdf` file
- an output directory for the USD artifact

Collect when present:

- mesh directories referenced by the URDF
- texture directories referenced by materials
- ROS package mappings for `package://<package_name>/<path>` references
- target runtime intent, such as visualization, Newton simulation, Isaac/PhysX validation, or profile validation

## Dependency Check

Before conversion, confirm the installed reference dependency check passes:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

This reference wraps the external `urdf_usd_converter` CLI. If conversion reports the external CLI as missing, check whether the dependency is installed:

```bash
urdf_usd_converter --help
```

If neither is available, stop and report the missing dependency. Do not install packages unless the user has approved dependency installation.

## Conversion Workflow

1. Inspect the URDF for referenced meshes, textures, links, joints, and `package://` paths.
2. Resolve relative asset paths from the URDF directory.
3. Resolve ROS package paths automatically when possible.
4. Ask for or derive explicit `--package name=path` mappings for unresolved `package://` references.
5. Run conversion into a clean output directory.
6. Identify the primary USD artifact returned by the converter or created in the output directory.
7. Record warnings for missing meshes, missing package mappings, unsupported URDF tags, or runtime-specific physics concerns.
8. Hand off the generated USD artifact to `validate-usd-minimum`.

## CLI Pattern

Prefer the installed reference-local script after confirming dependencies:

```bash
python3 scripts/run.py /path/to/robot.urdf /path/to/usd_robot --report /path/to/conversion_report.json
```

For ROS packages, pass one or more mappings:

```bash
python3 scripts/run.py /path/to/robot.urdf /path/to/usd_robot --package robot_package=/path/to/assets
```

The wrapper preserves the normalized skill-hub report and forwards supported
upstream `urdf_usd_converter` options verbatim. Use the upstream flag names for
single-file output, physics-scene omission, or authored comments:

```bash
python3 scripts/run.py /path/to/robot.urdf /path/to/usd_robot \
  --no-layer-structure \
  --no-physics-scene \
  --comment "Converted for validation"
```

Quote paths that contain spaces.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/convert-to-usd/references/urdf-usd-converter/scripts/run.py /path/to/robot.urdf /path/to/usd_robot --report /path/to/conversion_report.json
```

Open `report.output_usd_path` with USD tooling when a post-conversion check is needed.

## Output Format

Report:

- source URDF path
- output directory
- primary USD artifact path
- converter package and CLI/API used
- ROS package mappings used
- referenced mesh and texture counts when easy to determine
- unresolved references
- warnings and errors
- recommended next validation skill: `validate-usd-minimum`

## Known Caveats

The converter is described by its maintainers as alpha. It targets standalone OpenUSD assets suitable for visualization and Newton import, but simulation behavior in other UsdPhysics runtimes may require additional adaptation. Record those runtime concerns instead of treating them as conversion failures.
