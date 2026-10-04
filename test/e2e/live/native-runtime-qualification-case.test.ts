// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import {
  executeNativeRuntimeQualificationCase,
  NATIVE_RUNTIME_QUALIFICATION_E2E_PHASES,
} from "./native-runtime-qualification-case-executor.ts";

const ENABLED =
  process.env.NEMOCLAW_RUN_LIVE_E2E === "1" &&
  typeof process.env.NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_ROW === "string";

test.skipIf(!ENABLED)(
  "executes one exact credential-free native runtime qualification case",
  { meta: { e2ePhases: NATIVE_RUNTIME_QUALIFICATION_E2E_PHASES }, timeout: 1_800_000 },
  async ({ progress }) => executeNativeRuntimeQualificationCase(progress),
);
