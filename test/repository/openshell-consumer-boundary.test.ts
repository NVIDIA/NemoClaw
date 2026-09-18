// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  evaluateOpenShellConsumerBoundary,
  parseOpenShellConsumerManifest,
  scanOpenShellConsumers,
  type ConsumerFinding,
  type OpenShellConsumerManifest,
} from "../../scripts/checks/openshell-consumer-boundary.mts";
import { describe, expect, test } from "../helpers/owned-test-resources";

function writeModule(root: string, file: string, source: string): void {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, source);
}

function manifest(
  sites: OpenShellConsumerManifest["consumerGroups"][number]["sites"] = [],
): OpenShellConsumerManifest {
  return {
    schemaVersion: 1,
    issue: 9813,
    historicalOperations: [
      {
        id: "baseline",
        capability: "test capability",
        consumer: "test consumer",
        disposition: "typed-cli-implementation",
        evidence: "test evidence",
        owner: "test owner",
        reason: "test reason",
        removalCondition: "test removal condition",
        operations: Array.from({ length: 44 }, (_, index) => `operation-${index}`),
      },
    ],
    consumerGroups: [
      {
        id: "test-consumers",
        capability: "test capability",
        consumer: "test consumers",
        disposition: "dependency-deferral",
        evidence: "test evidence",
        owner: "test owner",
        reason: "test reason",
        removalCondition: "test removal condition",
        sites,
      },
    ],
  };
}

function allowance(
  finding: ConsumerFinding,
): OpenShellConsumerManifest["consumerGroups"][number]["sites"][number] {
  return {
    path: finding.path,
    kinds: finding.kinds,
    operations: finding.operations,
  };
}

describe("OpenShell consumer boundary (#9813)", () => {
  test("finds stable production consumer identities without line-number coupling", ({
    resources,
  }) => {
    const root = resources.temporaryDirectory("nemoclaw-openshell-consumers-");
    writeModule(
      root,
      "src/consumer.ts",
      'import { captureOpenshell } from "./lib/adapters/openshell/runtime";\n' +
        'captureOpenshell(["sandbox", "get", "example"]);\n',
    );
    writeModule(
      root,
      "nemoclaw/src/plugin.ts",
      'deps.run(["openshell", "provider", "refresh", "status", "example"]);\n',
    );
    writeModule(
      root,
      "src/lib/adapters/openshell/owned.ts",
      'captureOpenshell(["sandbox", "get", "owned"]);\n',
    );
    writeModule(root, "src/ignored.test.ts", 'runOpenshell(["sandbox", "delete", "x"]);\n');

    expect(scanOpenShellConsumers(root)).toEqual([
      {
        id: "consumer:nemoclaw/src/plugin.ts",
        kinds: ["direct-argv"],
        operations: ["provider refresh status"],
        path: "nemoclaw/src/plugin.ts",
      },
      {
        id: "consumer:src/consumer.ts",
        kinds: ["direct-argv", "raw-runtime-import"],
        operations: ["arbitrary argv", "sandbox get"],
        path: "src/consumer.ts",
      },
    ]);
  });

  test("finds direct executable calls and generic helper definitions", ({ resources }) => {
    const root = resources.temporaryDirectory("nemoclaw-openshell-executable-");
    writeModule(
      root,
      "src/direct.ts",
      "function runOpenshell(args: string[]): void {}\n" +
        'runOpenshell(["sandbox", "future-operation"]);\n' +
        'spawnSync("openshell", ["gateway", "info"]);\n',
    );

    expect(scanOpenShellConsumers(root)).toEqual([
      {
        id: "consumer:src/direct.ts",
        kinds: ["direct-argv", "direct-executable", "raw-helper-definition"],
        operations: ["arbitrary argv", "gateway info", "sandbox future-operation"],
        path: "src/direct.ts",
      },
    ]);
  });

  test("rejects unknown consumers and allowances whose source signal disappeared", () => {
    const current: ConsumerFinding = {
      id: "consumer:src/new.ts",
      kinds: ["direct-argv"],
      operations: ["sandbox get"],
      path: "src/new.ts",
    };
    const stale: ConsumerFinding = {
      id: "consumer:src/old.ts",
      kinds: ["raw-runtime-import"],
      operations: ["arbitrary argv"],
      path: "src/old.ts",
    };

    const violations = evaluateOpenShellConsumerBoundary([current], manifest([allowance(stale)]));

    expect(violations.map((entry) => entry.kind)).toEqual(["unknown-consumer", "stale-allowance"]);
  });

  test("rejects changed operations under an existing consumer path", () => {
    const current: ConsumerFinding = {
      id: "consumer:src/consumer.ts",
      kinds: ["direct-argv"],
      operations: ["sandbox delete"],
      path: "src/consumer.ts",
    };
    const allowed = allowance({ ...current, operations: ["sandbox get"] });

    expect(evaluateOpenShellConsumerBoundary([current], manifest([allowed]))).toContainEqual(
      expect.objectContaining({
        id: current.id,
        kind: "invalid-manifest",
      }),
    );
  });

  test("requires exactly 44 unique historical operation contracts", () => {
    const valid = manifest();
    const group = valid.historicalOperations[0]!;
    const duplicate = {
      ...valid,
      historicalOperations: [
        {
          ...group,
          operations: [...group.operations.slice(0, 43), "operation-0"],
        },
      ],
    };

    expect(evaluateOpenShellConsumerBoundary([], duplicate).map((entry) => entry.id)).toContain(
      "historical-operation-duplicates",
    );
    const short = {
      ...valid,
      historicalOperations: [{ ...group, operations: group.operations.slice(0, 43) }],
    };
    expect(evaluateOpenShellConsumerBoundary([], short).map((entry) => entry.id)).toContain(
      "historical-operation-count",
    );
  });

  test("rejects a manifest for another issue or schema", () => {
    expect(() =>
      parseOpenShellConsumerManifest(
        JSON.stringify({
          schemaVersion: 2,
          issue: 9813,
          historicalOperations: [],
          consumerGroups: [],
        }),
      ),
    ).toThrow("schema 1 for issue #9813");
  });
});
