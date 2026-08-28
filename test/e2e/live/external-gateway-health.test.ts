// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import {
  EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS,
  runExternalGatewayHealthScenario,
} from "./external-gateway-health-helpers.ts";

test(
  "OpenShell public health accepts the reviewed SDK over explicit HTTPS and CA (#9872)",
  {
    timeout: EXTERNAL_GATEWAY_HEALTH_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "confirm the exact OpenShell gateway and SDK prerequisites",
        "launch a TLS gateway without client-certificate authentication",
        "observe public health through the reviewed SDK",
      ],
    },
  },
  runExternalGatewayHealthScenario,
);
