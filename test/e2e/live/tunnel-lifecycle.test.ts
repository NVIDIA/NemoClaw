// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 *
 * Preserves the real boundaries: Docker/OpenShell onboarding, the
 * installed/source NemoClaw CLI, host `cloudflared`, the local dashboard origin,
 * public trycloudflare reachability, cloudflared log diagnosis, and tunnel stop
 * cleanup/status removal.
 */

import { test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2E } from "../fixtures/live-project-gate.ts";
import {
  runTunnelLifecycleContract,
  TUNNEL_LIFECYCLE_TEST_TIMEOUT_MS,
} from "./tunnel-lifecycle-helpers.ts";

test.skipIf(!shouldRunLiveE2E())(
  "tunnel-lifecycle: cloudflared quick tunnel starts, serves OpenClaw, and stops cleanly",
  { timeout: TUNNEL_LIFECYCLE_TEST_TIMEOUT_MS },
  runTunnelLifecycleContract,
);
