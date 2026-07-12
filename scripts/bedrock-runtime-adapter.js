#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  startBedrockRuntimeAdapterFromEnv,
} = require("../dist/lib/inference/bedrock-runtime-adapter");

try {
  startBedrockRuntimeAdapterFromEnv();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
