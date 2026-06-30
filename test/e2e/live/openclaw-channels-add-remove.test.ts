// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { testTimeoutOptions } from "../../helpers/timeouts";
import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  CHANNELS_ADD_REMOVE_TIMEOUT_MS,
  runChannelsAddRemoveTarget,
} from "./channels-lifecycle-helpers.ts";

test.skipIf(!shouldRunLiveE2E())(
  "openclaw channels add/remove covers every supported channel",
  testTimeoutOptions(CHANNELS_ADD_REMOVE_TIMEOUT_MS),
  (fixtures) => runChannelsAddRemoveTarget("openclaw", fixtures),
);
