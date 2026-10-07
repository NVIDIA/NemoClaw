// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { catalogueTargetsForChangedFiles } from "../../../tools/e2e/target-catalogue.mts";

describe("tunnel lifecycle E2E selection", () => {
  it.each([
    "src/commands/tunnel/start.ts",
    "src/commands/tunnel/status.ts",
    "src/commands/tunnel/stop.ts",
    "src/lib/tunnel/services.ts",
    "src/lib/tunnel/service-command.ts",
    "test/e2e/live/tunnel-lifecycle-helpers.ts",
  ])("selects tunnel lifecycle evidence when %s changes", (changedFile) => {
    expect(catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id)).toContain(
      "tunnel-lifecycle",
    );
  });
});
