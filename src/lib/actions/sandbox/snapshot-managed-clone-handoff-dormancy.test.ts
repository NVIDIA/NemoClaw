// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("managed snapshot clone handoff activation boundary", () => {
  it("keeps the PR3.9 contract unwired while production restore stays fail-closed", () => {
    const dependencies = readFileSync(
      new URL("./snapshot/dependencies.ts", import.meta.url),
      "utf8",
    );
    const productionAction = readFileSync(new URL("./snapshot.ts", import.meta.url), "utf8");

    expect(dependencies).not.toContain("prepareManagedWorkloadCloneHandoff");
    expect(dependencies).not.toContain("ManagedWorkloadCloneHandoff");
    expect(productionAction).toContain("rejectManagedSnapshotCloneUntilRebind");
    expect(productionAction).not.toContain("prepareManagedWorkloadCloneHandoff");
    expect(productionAction).not.toContain("ManagedWorkloadCloneHandoff");
    expect(productionAction).not.toContain("prepareManagedCloneProviders");
    expect(productionAction).not.toContain("provisionManagedCloneProviders");
  });
});
