// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  REVIEWED_LEGACY_SANDBOX_TRANSPORT_SITES,
  auditLegacySandboxTransports,
  discoverLegacySandboxTransportSites,
} from "../scripts/checks/legacy-sandbox-transports";

const fixtures: string[] = [];

function fixtureRepo(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-transports-"));
  fixtures.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  return root;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

describe("legacy sandbox transport inventory", () => {
  it("discovers the direct sandbox transport shapes that the migration must remove", () => {
    const root = fixtureRepo({
      "src/transport.ts": [
        'spawnSync("ssh", ["sandbox"]);',
        'run(["ssh", "sandbox"]);',
        'collect(root, "probe", "ssh", ["sandbox"]);',
        'deps.run("sshfs", ["sandbox:/", "/mnt"]);',
        'captureOpenshell(["sandbox", "ssh-config", "alpha"]);',
        'captureSandboxSshConfig("alpha");',
        'createTempSshConfig(config, "prefix-");',
        'privilegedSandboxExecArgv("alpha", ["true"]);',
        'dockerExecArgv("openshell-cluster-nemoclaw", ["true"]);',
        'dockerSpawnSync(["exec", "openshell-cluster-nemoclaw", "true"]);',
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([
      { relativePath: "src/transport.ts", kind: "docker-exec-builder", calls: 1 },
      { relativePath: "src/transport.ts", kind: "docker-exec-command", calls: 1 },
      { relativePath: "src/transport.ts", kind: "openshell-ssh-config", calls: 2 },
      { relativePath: "src/transport.ts", kind: "privileged-sandbox-exec", calls: 1 },
      { relativePath: "src/transport.ts", kind: "ssh-command", calls: 3 },
      { relativePath: "src/transport.ts", kind: "ssh-temp-config", calls: 1 },
      { relativePath: "src/transport.ts", kind: "sshfs-command", calls: 1 },
    ]);
  });

  it("discovers immutable command and callee aliases without claiming general data flow", () => {
    const root = fixtureRepo({
      "src/aliased-transport.ts": [
        'const sshCommand = "ssh";',
        "const invokeSsh = spawnSync;",
        'invokeSsh(sshCommand, ["sandbox"]);',
        'const sshfsCommand = ["sshfs", "sandbox:/", "/mnt"];',
        "const invokeSshfs = run;",
        "invokeSshfs(sshfsCommand);",
        'const dockerArgs = ["exec", "openshell-cluster-nemoclaw", "true"];',
        "const invokeDocker = dockerSpawnSync;",
        "invokeDocker(dockerArgs);",
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([
      {
        relativePath: "src/aliased-transport.ts",
        kind: "docker-exec-command",
        calls: 1,
      },
      { relativePath: "src/aliased-transport.ts", kind: "ssh-command", calls: 1 },
      { relativePath: "src/aliased-transport.ts", kind: "sshfs-command", calls: 1 },
    ]);
  });

  it("tracks reviewed read-only fallback importers, including aliased imports", () => {
    const root = fixtureRepo({
      "src/read-only-probe.ts": [
        'import { execSandboxReadOnlyWithGrpcFallback as execReadOnly } from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'execReadOnly("gateway", request);',
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([
      {
        relativePath: "src/read-only-probe.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
    ]);
  });

  it("tracks namespace imports and direct or aliased named re-exports", () => {
    const root = fixtureRepo({
      "src/namespace-import.ts":
        'import * as routing from "./lib/adapters/openshell/sandbox-control-routing.js";\nrouting.execSandboxReadOnlyWithGrpcFallback("gateway", request);',
      "src/re-export.ts": [
        'export { execSandboxReadOnlyWithGrpcFallback } from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'export { execSandboxReadOnlyWithGrpcFallback as execReadOnly } from "./lib/adapters/openshell/sandbox-control-routing.js";',
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([
      {
        relativePath: "src/namespace-import.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
      {
        relativePath: "src/re-export.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 2,
      },
    ]);
  });

  it("ignores type-only fallback imports and re-exports", () => {
    const root = fixtureRepo({
      "src/type-only.ts": [
        'import type { execSandboxReadOnlyWithGrpcFallback } from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'import { type execSandboxReadOnlyWithGrpcFallback as ExecReadOnly } from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'import type * as Routing from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'export type { execSandboxReadOnlyWithGrpcFallback } from "./lib/adapters/openshell/sandbox-control-routing.js";',
        'export { type execSandboxReadOnlyWithGrpcFallback as ExecReadOnlyExport } from "./lib/adapters/openshell/sandbox-control-routing.js";',
      ].join("\n"),
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([]);
  });

  it("keeps every reviewed read-only fallback importer explicit", () => {
    expect(
      REVIEWED_LEGACY_SANDBOX_TRANSPORT_SITES.filter(
        (site) => site.kind === "grpc-cli-read-only-fallback",
      ),
    ).toEqual([
      {
        relativePath: "src/lib/actions/sandbox/sessions/passthrough.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
      {
        relativePath: "src/lib/diagnostics/debug.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
      {
        relativePath: "src/lib/sandbox/version.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
      {
        relativePath: "src/lib/state/sandbox.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
      {
        relativePath: "src/lib/state/user-managed-files-probe.ts",
        kind: "grpc-cli-read-only-fallback",
        calls: 1,
      },
    ]);
  });

  it("fails closed when a new production file imports the read-only fallback", () => {
    const root = fixtureRepo({
      "src/unreviewed-probe.ts":
        'import { execSandboxReadOnlyWithGrpcFallback } from "./lib/adapters/openshell/sandbox-control-routing";',
    });

    expect(auditLegacySandboxTransports(root, [])).toEqual([
      "src/unreviewed-probe.ts:grpc-cli-read-only-fallback: found 1 unreviewed transport use(s)",
    ]);
  });

  it("ignores comments, inert strings, tests, and non-sandbox SSH workflows", () => {
    const root = fixtureRepo({
      "src/safe.ts": [
        '// spawnSync("ssh", ["sandbox"]);',
        'const example = "ssh";',
        'log("ssh");',
      ].join("\n"),
      "src/safe.test.ts": 'spawnSync("ssh", ["sandbox"]);',
      "src/lib/deploy/remote.ts": 'spawnSync("ssh", ["host"]);',
      "src/lib/actions/dns/colima.ts": 'run(["ssh", "vm"]);',
    });

    expect(discoverLegacySandboxTransportSites(root)).toEqual([]);
  });

  it("fails closed when a production site is not in the reviewed inventory", () => {
    const root = fixtureRepo({
      "src/new-path.ts": 'spawnSync("ssh", ["sandbox"]);',
    });

    expect(auditLegacySandboxTransports(root, [])).toEqual([
      "src/new-path.ts:ssh-command: found 1 unreviewed transport use(s)",
    ]);
  });
});
