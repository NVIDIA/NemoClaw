// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  isOpenShellSandboxId,
  parseOpenShellSandboxId,
  parseStrictOpenShellSandboxListJson,
} from "../../src/lib/adapters/openshell/sandbox-identity";

type CreatedSandboxFixture = {
  readonly capture: (command: string[]) => string | null;
  readonly create: (command: string[]) => void;
  readonly delete: () => void;
  readonly installRuntimeObservation: () => () => void;
  readonly recreate: (command: string[]) => void;
  readonly setPhase: (phase: string) => void;
  readonly run: (command: string[]) => { status: number; stdout: Buffer; stderr: Buffer } | null;
  readonly state: Readonly<{
    sandboxName: string;
    sandboxId: string;
    gatewayName: string;
    phase: string;
    lifecycleState: string;
    generation: number;
    createAttemptNonce: string | null;
    ownerScopedIdentityObserved: boolean;
  }>;
};

const requireCjs = createRequire(import.meta.url);
const { createCreatedSandboxFixture } = requireCjs("./onboard-script-mocks.cjs") as {
  createCreatedSandboxFixture: (options?: Record<string, unknown>) => CreatedSandboxFixture;
};

const CREATE_ATTEMPT_NONCE = "a".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);

function selectorListCommand(gatewayName: string | null, nonce = CREATE_ATTEMPT_NONCE): string[] {
  return [
    "openshell",
    "sandbox",
    "list",
    ...(gatewayName === null ? [] : ["-g", gatewayName]),
    "--selector",
    `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`,
    "--output",
    "json",
    "--limit",
    "2",
  ];
}

function createCommand(nonce = CREATE_ATTEMPT_NONCE, gatewayName: string | null = null): string[] {
  return [
    "openshell",
    "sandbox",
    "create",
    ...(gatewayName === null ? [] : ["-g", gatewayName]),
    "--label",
    `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`,
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
    fixture.create(createCommand());
    const createdSandboxId = fixture.state.sandboxId;

    const selectorOutput = fixture.capture(selectorListCommand("gateway-alpha"));
    const rows = parseStrictOpenShellSandboxListJson(selectorOutput ?? "");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.id).toBe(createdSandboxId);

    const listOutput = fixture.capture(["openshell", "sandbox", "list", "-g", "gateway-alpha"]);
    expect(listOutput).toBe("alpha Ready\n");
    expect(fixture.state.sandboxId).toBe(createdSandboxId);
    expect(fixture.run(["openshell", "sandbox", "get", "alpha"])).toBeNull();

    const getOutput = fixture.capture([
      "openshell",
      "sandbox",
      "get",
      "-g",
      "gateway-alpha",
      "alpha",
    ]);
    expect(parseOpenShellSandboxId(getOutput ?? "")).toBe(createdSandboxId);
    expect(
      parseOpenShellSandboxId(
        fixture.run(["openshell", "sandbox", "get", "alpha"])?.stdout.toString() ?? "",
      ),
    ).toBe(createdSandboxId);
  });

  it("invalidates the prior ID before recreation publishes a new ID (#10463)", () => {
    const fixture = createCreatedSandboxFixture({
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "gateway-alpha",
    });
    fixture.create(createCommand());
    const priorSandboxId = fixture.state.sandboxId;

    fixture.delete();
    expect(fixture.capture(selectorListCommand("gateway-alpha"))).toBe("[]");
    expect(fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-alpha", "alpha"])).toBe(
      "",
    );
    expect(
      fixture.run(["openshell", "sandbox", "get", "-g", "gateway-alpha", "alpha"]),
    ).toMatchObject({ status: 1 });

    const replacementNonce = "b".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH);
    fixture.recreate(createCommand(replacementNonce));
    const replacementSandboxId = fixture.state.sandboxId;
    expect(replacementSandboxId).not.toBe(priorSandboxId);
    const replacementRows = parseStrictOpenShellSandboxListJson(
      fixture.capture(selectorListCommand("gateway-alpha", replacementNonce)) ?? "",
    );
    expect(fixture.capture(selectorListCommand("gateway-alpha"))).toBe("[]");
    expect(replacementRows?.[0]?.id).toBe(replacementSandboxId);
    expect(replacementRows?.[0]?.id).not.toBe(priorSandboxId);
    expect(
      parseOpenShellSandboxId(
        fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-alpha", "alpha"]) ?? "",
      ),
    ).toBe(replacementSandboxId);
  });

  it("routes direct runtime observations through the fixture lifecycle (#10463)", () => {
    const fixture = createCreatedSandboxFixture({
      sandboxName: "alpha",
      sandboxId: "sandbox-alpha",
      gatewayName: "gateway-alpha",
    });
    const openshellRuntime = requireCjs("../../src/lib/adapters/openshell/runtime.ts") as {
      captureResolvedOpenshell: (args: string[]) => {
        status: number;
        stdout: string;
      };
    };
    const restore = fixture.installRuntimeObservation();
    const getSandbox = () =>
      openshellRuntime.captureResolvedOpenshell(["sandbox", "get", "-g", "gateway-alpha", "alpha"]);

    try {
      fixture.create(createCommand());
      expect(parseOpenShellSandboxId(getSandbox().stdout)).toBe(fixture.state.sandboxId);

      fixture.delete();
      expect(getSandbox().status).toBe(1);

      fixture.recreate(createCommand("b".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH)));
      expect(parseOpenShellSandboxId(getSandbox().stdout)).toBe(fixture.state.sandboxId);
    } finally {
      restore();
    }
  });

  it("keeps a replacement ID valid for a maximum-length input (#10463)", () => {
    const maximumSandboxId = "a".repeat(512);
    const fixture = createCreatedSandboxFixture({ sandboxId: maximumSandboxId });
    fixture.create(createCommand());
    fixture.delete();
    fixture.recreate(createCommand("b".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH)));

    expect(fixture.state.sandboxId).not.toBe(maximumSandboxId);
    expect(isOpenShellSandboxId(fixture.state.sandboxId)).toBe(true);
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
    fixture.create(createCommand());

    expect(fixture.capture(selectorListCommand("gateway-bravo"))).toBeNull();
    expect(
      fixture.capture(["openshell", "sandbox", "get", "-g", "gateway-bravo", "alpha"]),
    ).toBeNull();
    expect(fixture.capture(selectorListCommand(null))).toBeNull();
    expect(fixture.capture(["openshell", "sandbox", "get", "alpha"])).toBeNull();
  });

  it("rejects create and recreate commands for another gateway (#10463)", () => {
    const fixture = createCreatedSandboxFixture({ gatewayName: "gateway-alpha" });

    expect(() => fixture.create(createCommand(CREATE_ATTEMPT_NONCE, "gateway-bravo"))).toThrow(
      "Created sandbox fixture requires its configured gateway.",
    );
    expect(fixture.state.lifecycleState).toBe("absent");

    fixture.create(createCommand());
    fixture.delete();
    expect(() => fixture.recreate(createCommand(CREATE_ATTEMPT_NONCE, "gateway-bravo"))).toThrow(
      "Created sandbox fixture requires its configured gateway.",
    );
    expect(fixture.state.lifecycleState).toBe("deleted");
  });

  it("does not answer a selector for another create attempt (#10463)", () => {
    const fixture = createCreatedSandboxFixture({ gatewayName: "gateway-alpha" });
    fixture.create(createCommand());

    expect(
      fixture.capture(
        selectorListCommand("gateway-alpha", "b".repeat(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH)),
      ),
    ).toBe("[]");
  });

  it("rejects a malformed create-attempt nonce (#10463)", () => {
    const fixture = createCreatedSandboxFixture();

    expect(() => fixture.create(createCommand("invalid"))).toThrow(
      "Created sandbox fixture requires one valid create-attempt label.",
    );
  });
});
