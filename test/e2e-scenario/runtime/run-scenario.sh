#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DEPRECATED. The hybrid scenario architecture has a single supported runtime
# entrypoint: test/e2e-scenario/scenarios/run.ts. This bash runner duplicated
# install/onboard/gateway-check/suite-execution that now belongs in TS phase
# orchestrators (EnvironmentOrchestrator, OnboardingOrchestrator,
# RuntimeOrchestrator) and shared clients (HostCliClient, GatewayClient,
# SandboxClient). It is fail-fast so the deprecation is loud, not silent.

set -euo pipefail

cat >&2 <<'MSG'
run-scenario.sh is deprecated. Use the TS runner instead:

  npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id[,id...]>

Other run.ts modes (read-only):
  --list                List canonical scenario ids
  --emit-matrix         Emit GitHub Actions matrix payload from the registry
  --plan-only           Local debug: print the compiled plan, do not execute
                        (must NOT appear in any CI workflow)
MSG
exit 2
