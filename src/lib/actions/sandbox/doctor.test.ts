// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import type {
  SpawnSyncOptions,
  SpawnSyncReturns,
} from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import from dist/ rather than ./doctor: doctor.ts's transitive deps use bare
// CJS require("./relative") for sibling modules, which Node's CJS loader
// resolves fine against compiled .js but vitest cannot resolve to .ts on the
// fly. The same dist-import pattern is used by
// src/lib/actions/sandbox/status.test.ts.
import { dockerInspectGateway } from "../../../../dist/lib/actions/sandbox/doctor";

// Grab the *CJS-cached* node:child_process the compiled doctor.js will see.
// `import * as childProcess from "node:child_process"` returns a frozen ESM
// namespace whose properties cannot be redefined, so vi.spyOn fails. The
// require() path gives the mutable module object that the compiled dist
// module reads at each call.
const childProcessCjs = createRequire(import.meta.url)("node:child_process") as {
  spawnSync: typeof import("node:child_process").spawnSync;
};

// The `docker inspect` format string the doctor uses is:
//   {{.State.Running}}\t{{Health}}\t{{.Config.Image}}
const HEALTHY_INSPECT_STDOUT = "true\thealthy\topenshell/sandbox-from:1779075943";
// `docker port <container> 30051/tcp` returns the host-side mapping.
// The doctor accepts the mapping iff it contains `:${GATEWAY_PORT}` (default 8080).
const HOST_PORT_MAPPING_STDOUT = "0.0.0.0:8080\n";

type SpawnReply = SpawnSyncReturns<string>;

function spawnReply(stdout: string, status = 0): SpawnReply {
  return {
    status,
    stdout,
    stderr: "",
    pid: 1,
    output: [null, stdout, ""],
    signal: null,
  };
}

describe("dockerInspectGateway", () => {
  const originalSpawnSync = childProcessCjs.spawnSync;
  let spawnSyncMock: ReturnType<typeof vi.fn<(...args: unknown[]) => SpawnReply>>;

  beforeEach(() => {
    spawnSyncMock = vi.fn<(...args: unknown[]) => SpawnReply>();
    childProcessCjs.spawnSync = spawnSyncMock as unknown as typeof originalSpawnSync;
  });

  afterEach(() => {
    childProcessCjs.spawnSync = originalSpawnSync;
  });

  it("skips the port-mapping check when skipPortCheck=true (docker-driver mode)", () => {
    // Only one spawnSync call is expected (the inspect probe). A second call
    // would be the regression this test guards against.
    spawnSyncMock.mockReturnValueOnce(spawnReply(HEALTHY_INSPECT_STDOUT));

    const checks = dockerInspectGateway("openshell-jarvis-abc123", true);

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const firstCall = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      SpawnSyncOptions,
    ];
    expect(firstCall[0]).toBe("docker");
    expect(firstCall[1][0]).toBe("inspect");
    expect(firstCall[1]).toContain("openshell-jarvis-abc123");

    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      group: "Gateway",
      label: "Docker container",
      status: "ok",
    });
    expect(checks.find((c: { label: string }) => c.label === "Port mapping")).toBeUndefined();
  });

  it("runs the port-mapping check when skipPortCheck defaults to false (legacy K3s mode)", () => {
    // Two calls expected: inspect, then port. Both succeed.
    spawnSyncMock
      .mockReturnValueOnce(spawnReply(HEALTHY_INSPECT_STDOUT))
      .mockReturnValueOnce(spawnReply(HOST_PORT_MAPPING_STDOUT));

    const checks = dockerInspectGateway("openshell-cluster-nemoclaw");

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    const calls = spawnSyncMock.mock.calls as Array<
      [string, string[], SpawnSyncOptions]
    >;
    expect(calls[0][1][0]).toBe("inspect");
    expect(calls[1][1][0]).toBe("port");
    expect(calls[1][1]).toContain("30051/tcp");

    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      group: "Gateway",
      label: "Docker container",
      status: "ok",
    });
    expect(checks[1]).toMatchObject({
      group: "Gateway",
      label: "Port mapping",
      status: "ok",
    });
  });
});
