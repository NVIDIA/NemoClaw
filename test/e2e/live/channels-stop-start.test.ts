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
        "onboard channel lifecycle sandbox",
        "validate configured channel state",
        "stop and start the sandbox through OpenShell",
        "validate channel state after native readiness",
      ],
    },
  },
  runChannelsStopStartTarget,
);
