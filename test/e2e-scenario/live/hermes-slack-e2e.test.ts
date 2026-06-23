// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-hermes-slack-e2e.sh. */

import { testTimeoutOptions } from "../../helpers/timeouts";
import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import { LIVE_TIMEOUT_MS, runHermesSlackE2E } from "./hermes-slack-e2e-helpers.ts";

test.skipIf(!shouldRunLiveE2EScenarios())(
  "hermes-slack-e2e: onboards Hermes Slack and proves policy, placeholders, egress, and cleanup",
  testTimeoutOptions(LIVE_TIMEOUT_MS),
  runHermesSlackE2E,
);
