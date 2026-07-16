// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Compatibility boundary: the coverage-shard composite action resolves this
// exact path until it is updated to prefer e2e-mock-parity.mts. Keep this file
// forwarding to that implementation rather than duplicating its logic.

import { main } from "./e2e-mock-parity.mts";

main();
