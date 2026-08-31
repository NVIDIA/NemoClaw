// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createHermesShieldsProviderConsumerHarness,
  hermesProviderConsumerSandbox as sandbox,
} from "../helpers/hermes-shields-provider-consumer-harness";

const requireSource = createRequire(
  path.join(import.meta.dirname, "../../src/lib/shields/index.js"),
);

describe("managed Hermes shields-up confirmation", () => {
  let harness: ReturnType<typeof createHermesShieldsProviderConsumerHarness>;

  beforeEach(() => {
    harness = createHermesShieldsProviderConsumerHarness(requireSource);
  });

  afterEach(() => {
    harness.cleanup();
  });

  it("commits Shields up after one runtime provider state mutation and read-only confirmation (#10155)", () => {
    const statePaths = requireSource(
      "../state/paths.js",
    ) as typeof import("../../src/lib/state/paths");
    const statePath = path.join(
      statePaths.resolveNemoclawStateDir(),
      "shields-" + sandbox.name + ".json",
    );
    const events: string[] = [];
    let verification = 0;
    harness.transitionSpy.mockImplementation(() => {
      expect(fs.existsSync(statePath)).toBe(false);
      events.push("provider-mutation");
      return { fence: {}, proof: {} };
    });
    harness.verifyLockSpy.mockImplementation(() => {
      expect(fs.existsSync(statePath)).toBe(false);
      events.push(++verification === 1 ? "apply-verification" : "read-only-confirmation");
      return { issues: [] };
    });
    harness.auditSpy.mockImplementation(() => {
      expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
        shieldsDown: false,
      });
      events.push("up-commit");
    });

    harness.shields.shieldsUp(sandbox.name, { throwOnError: true });

    expect(events).toEqual([
      "provider-mutation",
      "apply-verification",
      "read-only-confirmation",
      "up-commit",
    ]);
    expect(harness.transitionSpy).toHaveBeenCalledOnce();
    expect(harness.transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: "locked", rollback: "mutable" }),
    );
    expect(harness.verifyLockSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
      shieldsDown: false,
      fileHashes: {
        "/sandbox/.hermes/config.yaml": "c".repeat(64),
        "/sandbox/.hermes/.env": "c".repeat(64),
        "/sandbox/.hermes/.config-hash": "c".repeat(64),
      },
    });
  });

  it("does not commit Shields up when read-only confirmation finds persistent drift (#10155)", () => {
    const statePaths = requireSource(
      "../state/paths.js",
    ) as typeof import("../../src/lib/state/paths");
    const statePath = path.join(
      statePaths.resolveNemoclawStateDir(),
      "shields-" + sandbox.name + ".json",
    );
    let verification = 0;
    harness.verifyLockSpy.mockImplementation(() => {
      expect(fs.existsSync(statePath)).toBe(false);
      verification += 1;
      return {
        issues: verification % 2 === 0 ? ["settled provider lock drift"] : [],
      };
    });

    expect(() => harness.shields.shieldsUp(sandbox.name, { throwOnError: true })).toThrow(
      /settled provider lock drift/u,
    );

    expect(harness.transitionSpy).toHaveBeenCalledTimes(3);
    expect(harness.transitionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ target: "locked", rollback: "mutable" }),
    );
    expect(harness.verifyLockSpy).toHaveBeenCalledTimes(6);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(harness.auditSpy).not.toHaveBeenCalled();
  });
});
