// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import { parseLiveSandboxNames } from "../../dist/lib/runtime-recovery";

describe("runtime recovery helpers", () => {
  it("parses live sandbox names from openshell sandbox list output", () => {
    expect(
      Array.from(
        parseLiveSandboxNames(
          [
            "NAME              NAMESPACE  CREATED              PHASE",
            "alpha             openshell  2026-03-24 10:00:00  Ready",
            "beta              openshell  2026-03-24 10:01:00  Provisioning",
          ].join("\n"),
        ),
      ),
    ).toEqual(["alpha", "beta"]);
  });

  it("treats no-sandboxes output as an empty set", () => {
    expect(Array.from(parseLiveSandboxNames("No sandboxes found."))).toEqual([]);
  });

  it("skips error lines", () => {
    expect(Array.from(parseLiveSandboxNames("Error: something went wrong"))).toEqual([]);
  });

  it("does not parse protobuf schema mismatch output as live sandbox state", () => {
    const output =
      'Error:   × status: Internal, message: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"';

    expect(Array.from(parseLiveSandboxNames(output))).toEqual([]);
  });

  it("handles empty input", () => {
    expect(Array.from(parseLiveSandboxNames(""))).toEqual([]);
    expect(Array.from(parseLiveSandboxNames())).toEqual([]);
  });
});
