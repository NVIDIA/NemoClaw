// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeoutOptions } from "../../helpers/timeouts";
import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import { LIVE_TIMEOUT_MS, runHermesSlackE2E } from "./hermes-slack-e2e-helpers.ts";

test.skipIf(!shouldRunLiveE2E())(
  "hermes-slack-e2e: onboards Hermes Slack and proves policy, placeholders, egress, and cleanup",
  testTimeoutOptions(LIVE_TIMEOUT_MS),
  runHermesSlackE2E,
);
