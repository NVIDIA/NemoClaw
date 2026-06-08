#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DEPRECATED. Suite execution is now driven directly by the TS phase
# orchestrator (RuntimeOrchestrator -> PhaseOrchestrator.runShellStep) which
# spawns each migrated assertion step's implementation.ref shell script.
# There is no longer a YAML-walking bash suite runner.

set -euo pipefail

cat >&2 <<'MSG'
run-suites.sh is deprecated. Suite assertions are now executed by
test/e2e-scenario/scenarios/orchestrators/phase.ts via child_process.spawn,
walking the typed assertionGroups defined in the scenario registry.

Run scenarios via:

  npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id[,id...]>
MSG
exit 2
