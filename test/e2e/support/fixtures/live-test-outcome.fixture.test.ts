// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

const outcome = process.env.NEMOCLAW_E2E_OUTCOME_FIXTURE;

it.runIf(outcome === "assertion")(
  "emits a deterministic assertion for the outcome reporter fixture (#7146)",
  () => {
    expect("actual").toBe("expected");
  },
);

it.runIf(outcome === "timeout")(
  "emits a Vitest timeout for the outcome reporter fixture (#7146)",
  async () => {
    await new Promise<void>(() => undefined);
  },
  10,
);

it.runIf(outcome !== "assertion" && outcome !== "timeout")(
  "stays inert outside the nested outcome-reporter contract (#7146)",
  () => undefined,
);
