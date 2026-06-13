// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import { parseLiveSandboxNames, parseReadySandboxNames } from "../../dist/lib/runtime-recovery";

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

  it("does not drop sandboxes whose name starts with 'name' or 'no'", () => {
    expect(
      Array.from(
        parseLiveSandboxNames(
          [
            "NAME              NAMESPACE  CREATED              PHASE",
            "name-prod         openshell  2026-03-24 10:00:00  Ready",
            "no-sandboxes      openshell  2026-03-24 10:01:00  Ready",
          ].join("\n"),
        ),
      ),
    ).toEqual(["name-prod", "no-sandboxes"]);
  });

  describe("parseReadySandboxNames", () => {
    it("includes sandboxes whose PHASE is Ready or Running", () => {
      expect(
        Array.from(
          parseReadySandboxNames(
            [
              "NAME              NAMESPACE  CREATED              PHASE",
              "alpha             openshell  2026-03-24 10:00:00  Ready",
              "epsilon           openshell  2026-03-24 10:00:30  Running",
              "beta              openshell  2026-03-24 10:01:00  Provisioning",
              "gamma             openshell  2026-03-24 10:02:00  Error",
              "delta             openshell  2026-03-24 10:03:00  Ready",
              "zeta              openshell  2026-03-24 10:04:00  NotReady",
            ].join("\n"),
          ),
        ),
      ).toEqual(["alpha", "epsilon", "delta"]);
    });

    it("skips sandboxes that report Error PHASE (stopped container)", () => {
      expect(
        Array.from(
          parseReadySandboxNames(
            [
              "NAME              NAMESPACE  CREATED              PHASE",
              "stopped-one       openshell  2026-03-24 10:00:00  Error",
            ].join("\n"),
          ),
        ),
      ).toEqual([]);
    });

    it("does not treat Ready or Running tokens outside the PHASE column as live", () => {
      expect(
        Array.from(
          parseReadySandboxNames(
            [
              "NAME              NAMESPACE  CREATED              PHASE",
              "alpha             Ready      2026-03-24 10:00:00  Provisioning",
              "beta              Running    2026-03-24 10:01:00  Error",
            ].join("\n"),
          ),
        ),
      ).toEqual([]);
    });

    it("treats no-sandboxes output, error lines, and protobuf mismatch as empty", () => {
      expect(Array.from(parseReadySandboxNames("No sandboxes found."))).toEqual([]);
      expect(Array.from(parseReadySandboxNames("Error: something went wrong"))).toEqual([]);
      expect(
        Array.from(
          parseReadySandboxNames(
            'Error:   × status: Internal, message: "Sandbox.metadata: SandboxResponse.sandbox: invalid wire type value: 6"',
          ),
        ),
      ).toEqual([]);
    });

    it("handles empty input", () => {
      expect(Array.from(parseReadySandboxNames(""))).toEqual([]);
      expect(Array.from(parseReadySandboxNames())).toEqual([]);
    });

    it("does not drop Ready sandboxes whose name starts with 'name' or 'no'", () => {
      expect(
        Array.from(
          parseReadySandboxNames(
            [
              "NAME              NAMESPACE  CREATED              PHASE",
              "name-prod         openshell  2026-03-24 10:00:00  Ready",
              "no-sandboxes      openshell  2026-03-24 10:01:00  Ready",
            ].join("\n"),
          ),
        ),
      ).toEqual(["name-prod", "no-sandboxes"]);
    });
  });
});
