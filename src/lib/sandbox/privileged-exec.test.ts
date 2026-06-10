// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Build must run before these tests (imports from dist/)
const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;
const helperPath = require.resolve("../../../dist/lib/sandbox/privileged-exec");
const dockerRunPath = require.resolve("../../../dist/lib/adapters/docker/run");
const registryPath = require.resolve("../../../dist/lib/state/registry");
const { containerNameMatchesSandbox, selectDirectSandboxContainer } = require(helperPath);

function withPrivilegedExecMocks<T>(
  deps: {
    dockerCapture: (args: readonly string[]) => string;
    getSandbox: (name: string) => { name?: string; openshellDriver?: string | null } | null;
    listSandboxes: () => {
      sandboxes?: Array<{ name?: string | null }>;
      defaultSandbox?: string | null;
    };
  },
  run: (helper: typeof import("../../../dist/lib/sandbox/privileged-exec")) => T,
): T {
  const priorHelper = require.cache[helperPath];
  const priorDockerRun = require.cache[dockerRunPath];
  const priorRegistry = require.cache[registryPath];

  delete require.cache[helperPath];
  requireCache[dockerRunPath] = {
    id: dockerRunPath,
    filename: dockerRunPath,
    loaded: true,
    exports: { dockerCapture: deps.dockerCapture },
  } as any;
  requireCache[registryPath] = {
    id: registryPath,
    filename: registryPath,
    loaded: true,
    exports: {
      getSandbox: deps.getSandbox,
      listSandboxes: deps.listSandboxes,
    },
  } as any;

  try {
    return run(require(helperPath));
  } finally {
    if (priorHelper) requireCache[helperPath] = priorHelper;
    else delete requireCache[helperPath];

    if (priorDockerRun) requireCache[dockerRunPath] = priorDockerRun;
    else delete requireCache[dockerRunPath];

    if (priorRegistry) requireCache[registryPath] = priorRegistry;
    else delete requireCache[registryPath];
  }
}

describe("privileged sandbox exec routing", () => {
  it("matches only the requested OpenShell sandbox container name pattern", () => {
    expect(containerNameMatchesSandbox("openshell-demo", "demo")).toBe(true);
    expect(containerNameMatchesSandbox("openshell-demo-abc123", "demo")).toBe(true);
    expect(containerNameMatchesSandbox("openshell-demolition", "demo")).toBe(false);
    expect(containerNameMatchesSandbox("openshell-gateway-nemoclaw", "demo")).toBe(false);
  });

  it("prefers the exact direct sandbox container when present", () => {
    const selected = selectDirectSandboxContainer(
      "demo",
      "openshell-demo-helper\nopenshell-demo\n",
      ["demo"],
    );

    expect(selected).toBe("openshell-demo");
  });

  it("falls back to a generated direct sandbox container suffix", () => {
    const selected = selectDirectSandboxContainer(
      "demo",
      "openshell-other\nopenshell-demo-abc123\n",
      ["demo"],
    );

    expect(selected).toBe("openshell-demo-abc123");
  });

  it("uses the longest registered sandbox-name match to avoid prefix collisions", () => {
    const containerNames = [
      "openshell-alpha-child",
      "openshell-alpha-child-2026",
      "openshell-alpha-abc123",
    ].join("\n");

    expect(selectDirectSandboxContainer("alpha", containerNames, ["alpha", "alpha-child"])).toBe(
      "openshell-alpha-abc123",
    );
    expect(
      selectDirectSandboxContainer("alpha-child", containerNames, ["alpha", "alpha-child"]),
    ).toBe("openshell-alpha-child");
  });

  it("does not consider unrelated OpenShell containers direct sandbox matches", () => {
    expect(
      selectDirectSandboxContainer("alpha", "openshell-gateway-nemoclaw\nopenshell-alpha-child\n", [
        "alpha",
        "alpha-child",
      ]),
    ).toBeNull();
  });

  it("builds privileged docker exec argv through the registered direct sandbox container", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha" }, { name: "alpha-child" }],
          defaultSandbox: "alpha",
        }),
        dockerCapture: () => "openshell-alpha-child\nopenshell-alpha-abc123\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(privilegedSandboxExecArgv("alpha", ["id"], true)).toEqual([
          "exec",
          "-i",
          "--user",
          "root",
          "openshell-alpha-abc123",
          "id",
        ]);
      },
    );
  });

  it("fails before docker discovery when the sandbox registry entry is unavailable", () => {
    let dockerPsCalls = 0;
    withPrivilegedExecMocks(
      {
        getSandbox: () => {
          throw new Error("registry corrupt");
        },
        listSandboxes: () => ({ sandboxes: [], defaultSandbox: null }),
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "openshell-alpha-child\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow("registry corrupt");
      },
    );
    expect(dockerPsCalls).toBe(0);
  });

  it("fails before docker discovery when registry disambiguation is unavailable", () => {
    let dockerPsCalls = 0;
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => {
          throw new Error("registry list unavailable");
        },
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "openshell-alpha-child\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          "registry list unavailable",
        );
      },
    );
    expect(dockerPsCalls).toBe(0);
  });

  it("surfaces docker discovery failures instead of reporting a missing container", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => {
          throw new Error("docker daemon unavailable");
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          "docker daemon unavailable",
        );
      },
    );
  });

  it("fails clearly when no matching direct sandbox container is running", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha" }, { name: "alpha-child" }],
          defaultSandbox: "alpha",
        }),
        dockerCapture: () => "openshell-alpha-child\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          /No running direct OpenShell sandbox container found for 'alpha'/,
        );
      },
    );
  });
});
