// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeout } from "../../helpers/timeouts.ts";
import { test } from "../fixtures/e2e-test.ts";
import {
  CHANNELS_STOP_START_TEST_NAME,
  LIVE_TIMEOUT_MS,
  runChannelsStopStartTarget,
} from "./channels-stop-start-helpers.ts";

test(
  CHANNELS_STOP_START_TEST_NAME,
  {
    timeout: testTimeout(LIVE_TIMEOUT_MS),
    meta: {
      e2ePhases: [
        "prepare channel lifecycle sandbox",
        "onboard sandbox with all messaging channels",
        "validate active channel integrations",
        "disable channels and rebuild sandbox",
        "re-enable channels, rebuild sandbox, and validate lifecycle state",
        "remove WeChat, Microsoft Teams, and Google Chat and validate cleanup",
      ],
    },
  },
  runChannelsStopStartTarget,
);
