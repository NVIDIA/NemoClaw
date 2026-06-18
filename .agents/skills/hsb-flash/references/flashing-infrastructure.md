# HSB Flash — Flashing Infrastructure

## Lattice board infrastructure

Lattice flashing uses the **HSB release repo that corresponds to the target FPGA version** when upgrading, or the **repo that corresponds to the current FPGA version** when downgrading. The skill checks out the required repo on the devkit if it is not already present (e.g., the user's existing repo from `/hsb-setup` may already be the correct version). See "FPGA version to repo mapping" below for the version-to-repo mapping.

The manifest YAML files for each flash step come from this skill's bundled `scripts/` directory and are copied to the checked-out repo before flashing. After flashing completes, any interim repos checked out by this skill (that differ from the user's original repo) are cleaned up.

## VB1940 infrastructure

VB1940 flashing **always uses the existing HSB repo on the devkit** — there is no v2.0.0 interim repo involved. The existing repo must be at version v2.3.0 or later. If no existing repo is found, instruct the user to run `/hsb-setup` first.

VB1940 flashing is always **single-step** — there is no gateway version concept and no two-step procedure.

The flash command runs **inside the demo container** from the repo root directory. The `program_leopard_cpnx100` tool is installed inside the container — no native build or `sudo` is required.

## GitHub releases

| Release | Tag     | Repository |
|---------|---------|------------|
| v2.0.0  | `2.0.0` | `https://github.com/nvidia-holoscan/holoscan-sensor-bridge` |
| v2.3.0  | `2.3.0` | `https://github.com/nvidia-holoscan/holoscan-sensor-bridge` |
| v2.3.1  | `2.3.1` | `https://github.com/nvidia-holoscan/holoscan-sensor-bridge` |
| v2.5.0  | `2.5.0` | `https://github.com/nvidia-holoscan/holoscan-sensor-bridge` |

Note: GitHub tags do **not** have a `v` prefix (use `2.0.0` not `v2.0.0`).

## Bundled manifest YAML files

This skill bundles the manifest YAML files from each relevant release so the agent does not need to clone separate repos just to obtain them. These files are in the `scripts/` directory alongside this SKILL.md:

```
scripts/
├── v2.0.0/
│   ├── manifest.yaml                      # Lattice FPGA 2412 manifest
│   ├── manifest-2407.yaml                 # Lattice FPGA 2407 manifest
│   ├── local_manifest.py                  # Utility: create manifest from local bit files
│   └── make_manifest.py                   # Utility: create manifest from NGC
├── v2.3.1/
│   ├── manifest.yaml                      # Lattice FPGA 2507 manifest
│   └── manifest_leopard_cpnx100.yaml      # VB1940 FPGA 2507 manifest
└── v2.5.0/
    ├── manifest.yaml                      # Lattice FPGA 2510 manifest
    └── manifest_leopard_cpnx100.yaml      # VB1940 FPGA 2510 manifest
```

When executing a flash step, **copy the appropriate manifest file from this skill's `scripts/` directory** to the flash repo on the remote host before running the flash command:
- **Lattice**: Copy the version-matching `manifest.yaml` (or `manifest-2407.yaml`) to the flash repo's `scripts/manifest.yaml`
- **VB1940**: Copy the version-matching `manifest_leopard_cpnx100.yaml` to the existing repo's `scripts/manifest_leopard_cpnx100.yaml`

This avoids needing to clone multiple release branches just for manifests.

## How the flash command works

### Lattice board flash command

**The exact Lattice flash command varies between HSB releases.** Do NOT assume a fixed command. The skill must read the user guide (`docs/user_guide/`) from the repo being used for flashing and extract the correct flash command for that specific version.

The Lattice flash command runs inside the demo container of the flash repo selected for that step (target's repo for upgrades, current's repo for downgrades). The command and its arguments are determined by reading that repo's documentation:

- Read the user guide from the flash repo (`$FLASH_REPO_DIR/docs/user_guide/`) and extract the flashing command for that version.
- For two-step downgrade, step 1 uses the flash repo matching the current FPGA version, while step 2 uses v2.0.0. Read the appropriate user guide for each step.
- For two-step upgrade (current = 2407), step 1 uses v2.0.0 (target 2412's repo), step 2 uses the repo corresponding to the final target FPGA version. Read the appropriate user guide for each step.

### v2.0.0 CLI flag placement (CRITICAL)

The v2.0.0 `hololink` CLI uses a **different flag ordering** from newer releases. Placing flags incorrectly causes "unrecognized arguments" errors:

- `--force` goes **before** the subcommand
- `--accept-eula` goes **after** the subcommand and its arguments

**Correct v2.0.0 syntax:**
```sh
hololink --force program scripts/manifest.yaml --accept-eula
```

**Wrong (will fail):**
```sh
hololink program scripts/manifest.yaml --force --accept-eula
```

Newer releases (v2.3.1+) accept `--force --accept-eula` after the subcommand arguments. When extracting the flash command from the user guide, always check the CLI help (`hololink --help` and `hololink program --help`) inside the container to confirm where each flag belongs for that specific version.

### FPGA 2407 enumerate incompatibility

After flashing to FPGA 2407, `hololink enumerate` **cannot detect the board**. The 2407 firmware uses an enumeration format that is incompatible with v2.0.0+ software. This is a known limitation.

**Workaround:** Use `hololink --force fpga_version` instead of `hololink enumerate` to read the FPGA version when the board is at (or expected to be at) version 2407:

```sh
hololink --force fpga_version
```

This command reads the FPGA version register directly, bypassing the enumeration protocol. Use this as the post-flash verification method whenever the expected FPGA version is 2407.

**Phase 1 detection fallback:** For Lattice boards, if all enumeration methods fail with the existing repo's container, the skill checks out HSB release repo v2.0.0 and retries enumeration using the v2.0.0 container. v2.0.0 is the baseline release that supports FPGA 2407 and 2412, so it has the highest compatibility with older firmware. If the v2.0.0 container also cannot read the FPGA version, the skill assumes 2407 and proceeds.

The Lattice flash procedure for each step is:
1. Copy the correct bundled manifest YAML to the flash repo's `scripts/manifest.yaml`
2. Run the flash command inside the flash demo container, using the correct flag placement for the repo version
3. After the flash completes, power cycle the board
4. Verify the new FPGA version:
   - If expected version is **2407**: use `hololink --force fpga_version` (enumerate does not work with 2407)
   - Otherwise: use `hololink enumerate`

### VB1940 flash command

The VB1940 uses a **different program tool** (`program_leopard_cpnx100`) from the Lattice board (`program_lattice_cpnx100`). Both tools are installed inside the demo container.

**The VB1940 flash command runs inside the demo container**, from the repo root directory:

```sh
program_leopard_cpnx100 scripts/manifest_leopard_cpnx100.yaml
```

The VB1940 flash procedure is:
1. Copy the correct bundled `manifest_leopard_cpnx100.yaml` to the existing repo's `scripts/manifest_leopard_cpnx100.yaml`
2. Run `program_leopard_cpnx100 scripts/manifest_leopard_cpnx100.yaml` inside the demo container (no `sudo` needed)
3. After the flash completes, power cycle the camera
4. Verify the new FPGA version with `hololink enumerate`

**NEVER run `program_leopard_cpnx100` on a Lattice board or `program_lattice_cpnx100` on a VB1940 — this can brick the device.**

The manifest YAML tells the flash tool:
- Which FPGA bitstream files to download (from Dropbox for VB1940, or NGC/edge.urm.nvidia.com for Lattice)
- The target FPGA version
- The board type (clnx/cpnx) and flashing strategy
