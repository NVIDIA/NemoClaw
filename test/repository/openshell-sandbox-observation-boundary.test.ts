// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  auditOpenShellSandboxObservationSources,
  findOpenShellSandboxObservationUsage,
  type OpenShellSandboxObservationDisposition,
} from "../../scripts/checks/openshell-sandbox-observation-boundary.mts";

function disposition(
  directCommands: number,
  legacyParserSites: number,
): OpenShellSandboxObservationDisposition {
  return {
    directCommands,
    legacyParserSites,
    ownerIssues: [9803],
    disposition: "follow-up",
    reason: "The accepted inventory issue owns this synthetic consumer.",
  };
}

describe("OpenShell sandbox observation boundary", () => {
  it("counts direct list and get commands with legacy parser bindings", () => {
    const usage = findOpenShellSandboxObservationUsage(
      `
        import { parseLiveSandboxEntries as parseEntries } from "./runtime-recovery";
        const list = ["openshell", "sandbox", "list", "-g", gateway];
        const get = ["sandbox", "get", sandboxName];
        parseEntries(output);
      `,
      "src/example.ts",
    );

    expect(usage).toEqual({ directCommands: 2, legacyParserSites: 1 });
  });

  it("counts namespace bindings that expose legacy parsers", () => {
    const usage = findOpenShellSandboxObservationUsage(
      `
        import * as runtimeRecovery from "./runtime-recovery";
        const gatewayState = require("./state/gateway");
        runtimeRecovery.parseLiveSandboxEntries(output);
        gatewayState.parseSandboxStatus(output);
      `,
      "src/example.ts",
    );

    expect(usage).toEqual({ directCommands: 0, legacyParserSites: 2 });
  });

  it("rejects an unclassified production observation consumer", () => {
    const sources = new Map([["src/new-consumer.ts", `run(["sandbox", "list"]);`]]);

    expect(() => auditOpenShellSandboxObservationSources(sources, {})).toThrow(
      /src\/new-consumer\.ts: unclassified observation usage/u,
    );
  });

  it("rejects another observation command in a classified consumer", () => {
    const sources = new Map([
      ["src/existing-consumer.ts", `run(["sandbox", "list"]); run(["sandbox", "get", "alpha"]);`],
    ]);
    const dispositions = {
      "src/existing-consumer.ts": disposition(1, 0),
    };

    expect(() => auditOpenShellSandboxObservationSources(sources, dispositions)).toThrow(
      /observation usage changed/u,
    );
  });

  it("rejects a stale disposition after its consumer migrates", () => {
    const sources = new Map([["src/migrated-consumer.ts", "export const migrated = true;"]]);
    const dispositions = {
      "src/migrated-consumer.ts": disposition(1, 0),
    };

    expect(() => auditOpenShellSandboxObservationSources(sources, dispositions)).toThrow(
      /stale disposition has no observation usage/u,
    );
  });

  it("rejects a disposition without an owner issue or reason", () => {
    const sources = new Map([["src/unowned-consumer.ts", `run(["sandbox", "list"]);`]]);
    const dispositions = {
      "src/unowned-consumer.ts": {
        ...disposition(1, 0),
        ownerIssues: [],
        reason: "",
      },
    };

    expect(() => auditOpenShellSandboxObservationSources(sources, dispositions)).toThrow(
      /disposition must name an owner issue and reason/u,
    );
  });
});
