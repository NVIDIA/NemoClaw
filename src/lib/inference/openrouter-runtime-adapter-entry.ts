// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { startOpenRouterRuntimeAdapterFromEnv } from "./openrouter-runtime-adapter-server";

try {
  startOpenRouterRuntimeAdapterFromEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
