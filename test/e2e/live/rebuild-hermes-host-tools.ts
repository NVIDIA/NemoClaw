// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import { CLI_DIST_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";

export async function ensureRebuildHermesHostTools(host: HostCliClient): Promise<void> {
  const bootstrapEnv = buildAvailabilityProbeEnv();
  if (!fs.existsSync(CLI_DIST_ENTRYPOINT)) {
    const build = await host.command("npm", ["run", "build:cli"], {
      artifactName: "prereq-build-checked-out-cli",
      cwd: REPO_ROOT,
      env: bootstrapEnv,
      timeoutMs: 10 * 60_000,
    });
    assertExitZero(build, "build checked-out NemoClaw CLI for protected E2E");
  }

  if (!(await host.isCommandAvailable("openshell", { env: bootstrapEnv }))) {
    const install = await host.command("bash", ["scripts/install-openshell.sh"], {
      artifactName: "prereq-install-openshell",
      cwd: REPO_ROOT,
      env: bootstrapEnv,
      timeoutMs: 10 * 60_000,
    });
    assertExitZero(install, "install OpenShell for protected E2E");
  }
}
