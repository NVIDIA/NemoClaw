// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { gatewayRemovalHintLines } from "./gateway-removal-hint";

describe("gatewayRemovalHintLines", () => {
  it("prints only the modern remove verb when the installed OpenShell has no lifecycle commands (#8139)", () => {
    const lines = gatewayRemovalHintLines("nemoclaw", false);

    expect(lines).toEqual(["    openshell gateway remove nemoclaw"]);
    expect(lines.join("\n")).not.toContain("gateway destroy");
  });

  it("omits the legacy destroy verb when support is unknown", () => {
    expect(gatewayRemovalHintLines("nemoclaw").join("\n")).not.toContain("gateway destroy");
  });

  it("appends the legacy destroy verb only when the installed OpenShell advertises it", () => {
    const lines = gatewayRemovalHintLines("nemoclaw", true);

    expect(lines).toEqual([
      "    openshell gateway remove nemoclaw",
      "    # For OpenShell releases that still expose lifecycle commands:",
      "    openshell gateway destroy -g nemoclaw",
    ]);
  });

  it("renders the caller's gateway name in every emitted command", () => {
    const lines = gatewayRemovalHintLines("nemoclaw-8081", true);

    expect(lines).toContain("    openshell gateway remove nemoclaw-8081");
    expect(lines).toContain("    openshell gateway destroy -g nemoclaw-8081");
    expect(lines.join("\n")).not.toMatch(/\bnemoclaw\b(?!-8081)/);
  });
});
