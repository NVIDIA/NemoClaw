// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-channels-stop-start.sh. */

import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import {
  CHANNELS_STOP_START_TEST_NAME,
  LIVE_TIMEOUT_MS,
  runChannelsStopStartScenario,
} from "./channels-stop-start-helpers.ts";

test.skipIf(!shouldRunLiveE2EScenarios())(
  CHANNELS_STOP_START_TEST_NAME,
  { timeout: LIVE_TIMEOUT_MS },
  runChannelsStopStartScenario,
);
