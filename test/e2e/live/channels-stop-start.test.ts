// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  CHANNELS_STOP_START_TEST_NAME,
  LIVE_TIMEOUT_MS,
  runChannelsStopStartTarget,
} from "./channels-stop-start-helpers.ts";

test.skipIf(!shouldRunLiveE2E())(
  CHANNELS_STOP_START_TEST_NAME,
  { timeout: LIVE_TIMEOUT_MS },
  runChannelsStopStartTarget,
);
