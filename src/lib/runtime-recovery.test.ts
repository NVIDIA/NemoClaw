// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist/ for correct coverage attribution.
import {
  classifyGatewayStatus,
  classifySandboxLookup,
  parseLiveSandboxNames,
  shouldAttemptGatewayRecovery,
} from "../../dist/lib/runtime-recovery";

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

  it("handles empty input", () => {
    expect(Array.from(parseLiveSandboxNames(""))).toEqual([]);
    expect(Array.from(parseLiveSandboxNames())).toEqual([]);
  });

  it("classifies missing sandbox lookups", () => {
    expect(
      classifySandboxLookup('Error:   × status: NotFound, message: "sandbox not found"').state,
    ).toBe("missing");
    expect(classifySandboxLookup("").state).toBe("missing");
  });

  it("classifies transport and gateway failures as unavailable", () => {
    expect(
      classifySandboxLookup(
        "Error:   × transport error\n  ╰─▶ Connection reset by peer (os error 104)",
      ).state,
    ).toBe("unavailable");
    expect(
      classifySandboxLookup(
        "Error:   × client error (Connect)\n  ╰─▶ Connection refused (os error 111)",
      ).state,
    ).toBe("unavailable");
  });

  it("classifies successful sandbox lookups as present", () => {
    expect(
      classifySandboxLookup(
        ["Sandbox:", "", "  Id: abc", "  Name: my-assistant", "  Phase: Ready"].join("\n"),
      ).state,
    ).toBe("present");
  });

  it("classifies gateway status output for restart recovery", () => {
    expect(classifyGatewayStatus("Gateway: nemoclaw\nStatus: Connected").state).toBe("connected");
    expect(classifyGatewayStatus("Error:   × No active gateway").state).toBe("unavailable");
    expect(classifyGatewayStatus("").state).toBe("inactive");
    expect(classifyGatewayStatus("Gateway: nemoclaw\nStatus: Disconnected").state).toBe(
      "inactive",
    );
    expect(classifyGatewayStatus("Status: Not connected").state).toBe("inactive");
    expect(classifyGatewayStatus("Connected").state).toBe("connected");
  });

  it("only attempts gateway recovery when sandbox access is unavailable and gateway is down", () => {
    expect(
      shouldAttemptGatewayRecovery({ sandboxState: "unavailable", gatewayState: "unavailable" }),
    ).toBe(true);
    expect(
      shouldAttemptGatewayRecovery({ sandboxState: "unavailable", gatewayState: "inactive" }),
    ).toBe(true);
    expect(
      shouldAttemptGatewayRecovery({ sandboxState: "present", gatewayState: "unavailable" }),
    ).toBe(false);
    expect(
      shouldAttemptGatewayRecovery({ sandboxState: "missing", gatewayState: "inactive" }),
    ).toBe(false);
    expect(
      shouldAttemptGatewayRecovery({ sandboxState: "unavailable", gatewayState: "connected" }),
    ).toBe(false);
  });
});
