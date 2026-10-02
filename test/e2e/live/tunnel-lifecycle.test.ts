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
import {
  runTunnelLifecycleContract,
  TUNNEL_LIFECYCLE_TEST_TIMEOUT_MS,
} from "./tunnel-lifecycle-helpers.ts";

test(
  "tunnel-lifecycle: quick tunnel serves the registered non-default dashboard port and stops",
  {
    timeout: TUNNEL_LIFECYCLE_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm Docker and cloudflared prerequisites",
        "onboard the OpenClaw tunnel sandbox",
        "register the non-default dashboard port",
        "wait for the local dashboard origin",
        "start the quick tunnel and discover its URL",
        "verify cloudflared targets the registered dashboard port",
        "probe public tunnel reachability",
        "stop the tunnel and confirm status removal",
      ],
    },
  },
  runTunnelLifecycleContract,
);
