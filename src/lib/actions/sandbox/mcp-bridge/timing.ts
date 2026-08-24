// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sleepMs, waitUntil } from "../../../core/wait";

/** Keep MCP synchronization delays behind one domain-owned timing boundary. */
export const sleepMcpBridgeRetry = sleepMs;
export const waitForMcpBridgeCondition = waitUntil;
