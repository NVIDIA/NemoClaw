// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import { vi } from "vitest";
import { test } from "../../fixtures/e2e-test.ts";
import { registerRouterDiagnostics } from "../../live/model-router-provider-routed-inference-helpers.ts";

const scenario = process.env.NEMOCLAW_ROUTER_DIAGNOSTICS_FIXTURE;
const operations: Record<string, () => void> = {
  primary: () => {
    throw new Error("original completion failure");
  },
  success: () => {},
};

test.runIf(Boolean(scenario))(
  "router diagnostic failure preserves the test outcome and sandbox cleanup",
  async ({ artifacts, cleanup, progress }) => {
    vi.spyOn(artifacts, "writeJson").mockImplementationOnce(async () => {
      await artifacts.writeText("diagnostics-attempted.txt", "before destruction");
      throw new Error("diagnostic storage unavailable");
    });
    cleanup.add("destroy fake sandbox", async () => {
      await artifacts.writeText(
        "sandbox-destroyed.txt",
        await fs.readFile(artifacts.pathFor("diagnostics-attempted.txt"), "utf8"),
      );
    });
    registerRouterDiagnostics(cleanup, artifacts);
    progress.phase("record E2E fixture support outcome");
    operations[scenario!]!();
  },
);
