// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../../fixtures/workflow-e2e-test.ts";

test.runIf(process.env.NEMOCLAW_WORKFLOW_PROGRESS_FIXTURE === "redacted-fallback")(
  "records shared-job identity without exposing secrets",
  {
    meta: {
      e2ePhases: ["prepare shared workflow fixture", "release shared workflow fixture"],
    },
  },
  ({ progress }) => {
    progress.phase("release shared workflow fixture");
  },
);
