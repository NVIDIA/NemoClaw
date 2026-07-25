// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../../fixtures/e2e-test.ts";

test.runIf(process.env.NEMOCLAW_E2E_PROGRESS_FIXTURE === "identity")(
  "automatic progress fixture writes completed target and shard evidence",
  {
    meta: {
      e2ePhases: ["prepare progress artifact", "record final fixture phase"],
    },
  },
  ({ progress }) => {
    progress.phase("record final fixture phase");
  },
);
