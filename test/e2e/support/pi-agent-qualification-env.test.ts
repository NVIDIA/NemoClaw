// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPiQualificationEnvironment } from "./pi-agent-qualification-env.ts";

describe("Pi qualification environment", () => {
  it("keeps only the receipt-bound managed-image catalog authority", () => {
    const env = createPiQualificationEnvironment(
      {
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/workflow-catalog.json",
        NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: '{"pi":{"reference":"stale"}}',
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
      "/tmp/receipt-bound-catalog.json",
    );

    expect(env).toMatchObject({
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: "/tmp/receipt-bound-catalog.json",
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: "",
      NEMOCLAW_NON_INTERACTIVE: "1",
    });
  });
});
