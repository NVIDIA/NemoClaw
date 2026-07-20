// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { writeOpenShellSandboxDescriptorPreload } from "./openshell-sandbox-descriptor-preload";

it("overrides only the configured sandbox routing module", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-descriptor-preload-"));
  try {
    const routingDirectory = path.join(home, "adapters", "openshell");
    const snapshotDirectory = path.join(home, "actions", "sandbox");
    fs.mkdirSync(routingDirectory, { recursive: true });
    fs.mkdirSync(snapshotDirectory, { recursive: true });
    const routingModule = path.join(routingDirectory, "sandbox-control-routing.js");
    const snapshotModule = path.join(snapshotDirectory, "snapshot.cjs");
    const unrelatedModule = path.join(home, "unrelated.cjs");
    fs.writeFileSync(routingModule, 'module.exports = { source: "routing-original" };\n');
    fs.writeFileSync(
      snapshotModule,
      'module.exports = require("../../adapters/openshell/sandbox-control-routing");\n',
    );
    fs.writeFileSync(unrelatedModule, 'module.exports = { source: "unrelated-original" };\n');
    const nodeOptions = writeOpenShellSandboxDescriptorPreload(home, "sandbox:test");

    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `const routing = require(process.env.SNAPSHOT_MODULE);
const directRouting = require(process.env.ROUTING_MODULE);
const unrelated = require(process.env.UNRELATED_MODULE);
routing.getOpenShellSandboxDescriptor("nemoclaw", "alpha").then((descriptor) => {
  process.stdout.write(JSON.stringify({
    descriptor,
    directRouting,
    directRoutingWasOverridden: typeof directRouting.getOpenShellSandboxDescriptor === "function",
    routingSource: routing.source,
    unrelated,
  }));
});`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions,
          ROUTING_MODULE: routingModule,
          SNAPSHOT_MODULE: snapshotModule,
          UNRELATED_MODULE: unrelatedModule,
        },
      },
    );

    expect(JSON.parse(output)).toEqual({
      descriptor: { id: "alpha-id", image: "sandbox:test", name: "alpha" },
      directRouting: { source: "routing-original" },
      directRoutingWasOverridden: false,
      routingSource: "routing-original",
      unrelated: { source: "unrelated-original" },
    });
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});
