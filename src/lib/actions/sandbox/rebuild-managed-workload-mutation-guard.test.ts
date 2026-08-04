// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as managedWorkload from "../../onboard/workload/rebuild";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry/types";
import { revalidateManagedWorkloadRebuildBeforeDelete } from "./rebuild-preflight-guards";

const entry = {
  name: "alpha",
  openshellDriver: "docker",
} as SandboxEntry;
const handoff = {
  providerId: "docker",
} as managedWorkload.ManagedWorkloadRebuildHandoff;

describe("managed workload rebuild mutation guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the unchanged provider-bound workload authority", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);
    vi.spyOn(managedWorkload, "managedWorkloadRebuildHandoffMatchesEntry").mockReturnValue(true);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toBeNull();
  });

  it("blocks deletion when durable workload authority changes", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);
    vi.spyOn(managedWorkload, "managedWorkloadRebuildHandoffMatchesEntry").mockReturnValue(false);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("does not alter legacy rebuild validation", () => {
    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", undefined)).toBeNull();
  });
});
