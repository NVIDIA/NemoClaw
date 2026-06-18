# HSB Flash — Built-in help (`--help`)

If `$ARGUMENTS` contains `--help` or `-h`, print the following and stop:

```
HSB FPGA Flash Skill

USAGE
  /hsb-flash [OPTIONS]

OPTIONS
  --help, -h        Show this help message and exit
  --verbose         Show full raw command output for every phase
  --y               Auto-approve all phase gates (skip user confirmation
                    between phases). Not recommended — a confirmation
                    warning is shown before proceeding. All output is
                    saved to a timestamped log file.
  --force           Force flash even when current and target FPGA versions
                    match (re-flash), and continue despite pre-flash version
                    mismatches instead of stopping

ENVIRONMENT VARIABLES (set before invoking the skill)
  SSH_TARGET        Remote login target (e.g. ubuntu@10.0.0.1)
  REMOTE_ROOT       Remote working directory
  REMOTE_SUDO       Privilege escalation: 'sudo', 'sudo -n', or ''
  REMOTE_SSH_OPTS   Additional SSH options
  HSB_PLATFORM      Platform hint

SUPPORTED BOARD TYPES
  HSB Lattice       Standalone FPGA board (CPNX100-ETH-SENSOR-BRIDGE)
  VB1940            Leopard Imaging "all-in-one" Eagle Camera with
                    integrated Lattice FPGA

SUPPORTED FPGA VERSIONS — HSB LATTICE
  2407              Oldest supported version (YAML from v2.0.0)
  2412              Gateway version for two-step flashing (YAML from v2.0.0)
  2507              YAML from v2.3.1
  2510              Latest documented version (YAML from v2.5.0)
  Newer versions    FPGA versions newer than 2412 that are not listed above
                    are handled dynamically — the skill checks the public
                    release notes for a matching HSB release and self-updates.
                    Development builds with no matching release use the
                    existing repo on a best-effort basis.

SUPPORTED FPGA VERSIONS — VB1940
  2507              YAML from v2.3.0 (corresponds to HSB release v2.3.0)
  2510              Latest documented version (YAML from v2.5.0)
  Newer versions    Handled dynamically via release notes lookup,
                    same as Lattice (see above).

WORKFLOW PHASES
  Phase 0   Token-budget preflight; verify enough plan usage for a full run
  Phase 1   Verify board connectivity, detect board type, read FPGA version
  Phase 2   Select target FPGA version (depends on board type)
  Phase 3   Checkout required repo, prepare manifest YAML, present flash plan
  Phase 4   Execute flashing procedure (with power cycle verification)
  Phase 5   Generate and optionally save summary report
  Phase 6   Clean up flash artifacts (remove interim repos)

FLASHING INFRASTRUCTURE — HSB LATTICE
  The repo used for flashing depends on the direction:
    Upgrades  → use the repo matching the TARGET FPGA version
    Downgrades → use the repo matching the CURRENT FPGA version

  FPGA version to repo mapping:
    FPGA 2407, 2412  → v2.0.0
    FPGA 2507        → v2.3.1
    FPGA 2510        → v2.5.0

  If the user's existing repo (from /hsb-setup) matches the required
  version, it is used directly. Otherwise, the required version is
  checked out.

  Two-step flashing (through gateway version 2412) is required when:
  - Downgrading to 2407 from 2507 or 2510 (step 1 uses current's repo,
    step 2 uses v2.0.0)
  - Upgrading from 2407 to 2507 or 2510 (step 1 uses v2.0.0 for target
    2412, step 2 uses target FPGA's repo)
  All other transitions are single-step.

  Flash commands always include --force and --accept-eula for non-interactive
  execution. Manifest YAML files are patched to include fpga_uuid if missing.

  IMPORTANT: v2.0.0 CLI flag placement differs from newer releases:
    v2.0.0:  hololink --force program scripts/manifest.yaml --accept-eula
    v2.3.1+: hololink program scripts/manifest.yaml --force --accept-eula

  KNOWN ISSUE: FPGA 2407 enumerate incompatibility
    hololink enumerate cannot detect boards running FPGA 2407 when using
    v2.0.0+ software. Use "hololink --force fpga_version" as a fallback
    to read the FPGA version directly from the board.

  ENUMERATION FALLBACK (Lattice only):
    If all enumeration methods fail with the existing container, the skill
    checks out HSB release repo v2.0.0 and retries using the v2.0.0
    container. If that also fails, FPGA version is assumed to be 2407.

  After flashing, interim repos checked out by this skill are cleaned up.

FLASHING INFRASTRUCTURE — VB1940
  VB1940 always uses the existing HSB repo on the devkit (from /hsb-setup).
  No v2.0.0 interim repo is needed.

  VB1940 flashing is always single-step — no gateway version concept.

  Command: program_leopard_cpnx100 (available inside the demo container,
           no sudo needed)

CRITICAL SAFETY
  NEVER use program_leopard_cpnx100 on a Lattice board or
  program_lattice_cpnx100 on a VB1940. Mixing commands can brick the device.

EXAMPLES
  /hsb-flash
  /hsb-flash --verbose
  /hsb-flash --y
  /hsb-flash --y --verbose
  /hsb-flash --force
  /hsb-flash --force --verbose
  /hsb-flash --help
```
