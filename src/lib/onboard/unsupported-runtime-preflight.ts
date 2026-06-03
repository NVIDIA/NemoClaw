// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cliDisplayName } from "./branding";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import type { HostAssessment } from "./preflight";

// Reject unsupported container runtimes (currently only Podman with the
// Linux Docker-driver gateway) before any Docker-specific probes. Both
// the fresh preflight and `--resume` backstop call this; if `docker`
// resolves to Podman, surface the unsupported-runtime message instead of
// running bridge/DNS diagnostics that would be misleading.
export function rejectUnsupportedContainerRuntime(
  host: Pick<HostAssessment, "runtime">,
): void {
  if (isLinuxDockerDriverGatewayEnabled() && host.runtime === "podman") {
    console.error(`  ✗ ${cliDisplayName()} onboarding now uses OpenShell's Docker driver.`);
    console.error(`    Podman is not supported for this ${cliDisplayName()} integration path.`);
    console.error("    Switch to Docker Engine and rerun onboarding.");
    process.exit(1);
  }
}
