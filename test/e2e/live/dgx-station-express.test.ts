// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { runStationExpressSmoke, STATION_SMOKE_PHASES } from "../support/dgx-station-express.ts";

test(
  "Station Express installs cached Ultra vLLM and NemoClaw, routes inference, and cleans up runtime",
  {
    timeout: 48 * 60_000,
    meta: { e2ePhases: STATION_SMOKE_PHASES, e2eCleanupTimeoutMs: 6 * 60_000 },
  },
  async ({ host, sandbox, artifacts, progress, cleanup }) => {
    await artifacts.target.declare({
      id: "dgx-station-express",
      contract: [
        "local candidate Express installation",
        "default Ultra model and routed inference",
        "runtime cleanup with unchanged model-cache metadata and retained vLLM image",
      ],
    });
    await runStationExpressSmoke({
      host,
      sandbox,
      cleanup,
      environment: process.env,
      repoRoot: REPO_ROOT,
      phases: {
        inspect: () => progress.phase("inspect the prepared Station"),
        install: () => progress.phase("install Station Express from the candidate checkout"),
        assert: () => progress.phase("assert managed Ultra and routed inference"),
        cleanup: () => progress.phase("clean up the job runtime"),
      },
      writeEvidence: (name, value) => artifacts.writeJson(name, value),
    });
    await artifacts.target.complete({ id: "dgx-station-express" });
  },
);
