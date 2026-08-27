// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseOpenShellSandboxId,
  parseStrictOpenShellSandboxListJson,
} from "../../src/lib/adapters/openshell/sandbox-identity";

type CreatedSandboxFixture = {
  readonly capture: (command: string[]) => string | null;
  readonly create: () => void;
  readonly delete: () => void;
  readonly recreate: () => void;
  readonly setPhase: (phase: string) => void;
  readonly state: Readonly<{
    sandboxName: string;
    sandboxId: string;
    gatewayName: string;
    phase: string;
    lifecycleState: string;
    generation: number;
  }>;
};

const { createCreatedSandboxFixture } = require("./onboard-script-mocks.cjs") as {
  createCreatedSandboxFixture: (options?: Record<string, unknown>) => CreatedSandboxFixture;
};

const CREATE_ATTEMPT_NONCE = "a".repeat(62);

function selectorListCommand(gatewayName: string): string[] {
  return [
    "openshell",
    "sandbox",
    "list",
    "-g",
    gatewayName,
    "--selector",
    `ai.nvidia.nemoclaw.create-attempt=${CREATE_ATTEMPT_NONCE}`,
    "--output",
    "json",
    "--limit",
    "2",
  ];
}

describe("created sandbox fixture", () => {
  it("uses one ID for create, list, and get observations (#10463)", () => {
    const fixture = createCreatedSandboxFixture({
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "gateway-alpha",
    });

    expect(fixture.capture(selectorListCommand("gateway-alpha"))).toBe("[]");
    fixture.create();
    const createdSandboxId = fixture.state.sandboxId;

    const selectorOutput = fixture.capture(selectorListCommand("gateway-alpha"));
    const rows = parseStrictOpenShellSandboxListJson(selectorOutput ?? "");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.id).toBe(createdSandboxId);

    const listOutput = fixture.capture(["openshell", "sandbox", "list", "-g", "gateway-alpha"]);
    expect(listOutput).toBe("alpha Ready\n");
    expect(fixture.state.sandboxId).toBe(createdSandboxId);

    const getOutput = fixture.capture([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "gateway-alpha",
      "alpha",
    ]);
    expect(parseOpenShellSandboxId(getOutput ?? "")).toBe(createdSandboxId);
  });

  it("invalidates the prior ID before recreation publishes a new ID (#10463)", () => {
    const fixture = createCreatedSandboxFixture({
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "gateway-alpha",
    });
    fixture.create();
    const priorSandboxId = fixture.state.sandboxId;

    fixture.delete();
    expect(fixture.capture(selectorListCommand("gateway-alpha"))).toBe("[]");
    expect(fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-alpha", "alpha"])).toBe(
      "",
    );

    fixture.recreate();
    const replacementSandboxId = fixture.state.sandboxId;
    expect(replacementSandboxId).not.toBe(priorSandboxId);
    const replacementRows = parseStrictOpenShellSandboxListJson(
      fixture.capture(selectorListCommand("gateway-alpha")) ?? "",
    );
    expect(replacementRows?.[0]?.id).toBe(replacementSandboxId);
    expect(replacementRows?.[0]?.id).not.toBe(priorSandboxId);
    expect(
      parseOpenShellSandboxId(
        fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-alpha", "alpha"]) ?? "",
      ),
    ).toBe(replacementSandboxId);
  });

  it.each([
    ["a missing", undefined],
    ["an empty", ""],
    ["a malformed", "invalid/id"],
  ])("rejects %s durable sandbox ID (#10463)", (_case, sandboxId) => {
    expect(() => createCreatedSandboxFixture({ sandboxId })).toThrow(
      "Created sandbox fixture requires one durable sandbox ID.",
    );
  });

  it("does not answer an identity observation for another gateway (#10463)", () => {
    const fixture = createCreatedSandboxFixture({
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "gateway-alpha",
    });
    fixture.create();

    expect(fixture.capture(selectorListCommand("gateway-bravo"))).toBeNull();
    expect(
      fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-bravo", "alpha"]),
    ).toBeNull();
  });
});
