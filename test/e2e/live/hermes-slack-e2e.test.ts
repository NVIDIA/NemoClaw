// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeoutOptions } from "../../helpers/timeouts";
import { test } from "../fixtures/e2e-test.ts";
import { LIVE_TIMEOUT_MS, runHermesSlackE2E } from "./hermes-slack-e2e-helpers.ts";

test(
  "hermes-slack-e2e: onboards Hermes Slack and proves policy, placeholders, egress, and cleanup",
  {
    ...testTimeoutOptions(LIVE_TIMEOUT_MS),
    meta: {
      e2ePhases: [
        "check Hermes Slack prerequisites",
        "install Hermes Slack sandbox",
        "validate Slack providers and Hermes health",
        "inspect Slack config and secret isolation",
        "validate Hermes-scoped Slack policy",
        "exercise Slack API through credential aliases",
        "remove Hermes Slack sandbox",
        "record Hermes Slack results",
      ],
    },
  },
  runHermesSlackE2E,
);
