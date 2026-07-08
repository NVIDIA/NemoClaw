// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The shared source hook preserves the writable CommonJS cache used by these mocks.
const require = createRequire(import.meta.url);
const requireCache: Record<string, unknown> = require.cache as any;
const helperPath = require.resolve("./privileged-exec");
const dockerRunPath = require.resolve("../adapters/docker/run");
const registryPath = require.resolve("../state/registry");
const { containerNameMatchesSandbox, selectDirectSandboxContainer } = require(helperPath);

function withPrivilegedExecMocks<T>(
  deps: {
    dockerCapture: (args: readonly string[], options?: { timeout?: number }) => string;
    getSandbox: (name: string) => { name?: string; openshellDriver?: string | null } | null;
    listSandboxes: () => {
      sandboxes?: Array<{ name?: string | null }>;
      defaultSandbox?: string | null;
    };
  },
  run: (helper: typeof import("./privileged-exec")) => T,
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

  it("selects the immutable id of one labeled direct sandbox container", () => {
    expect(selectDirectSandboxContainer("demo", "abc123\topenshell-demo-2026\n", ["demo"])).toBe(
      "abc123",
    );
  });

  it("rejects ambiguous labeled running containers", () => {
    expect(() =>
      selectDirectSandboxContainer(
        "demo",
        "abc123\topenshell-demo-one\ndef456\topenshell-demo-two\n",
        ["demo"],
      ),
    ).toThrow(/Multiple running OpenShell containers.*refusing ambiguous/);
  });

  it("rejects malformed Docker metadata", () => {
    expect(() => selectDirectSandboxContainer("demo", "openshell-demo\n", ["demo"])).toThrow(
      /malformed OpenShell sandbox container metadata/,
    );
  });

  it("rejects an authoritative label and container-name mismatch", () => {
    expect(() =>
      selectDirectSandboxContainer("alpha", "gateway-id\topenshell-gateway-nemoclaw\n", ["alpha"]),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });

  it("uses the longest registered sandbox-name match to reject prefix collisions", () => {
    expect(() =>
      selectDirectSandboxContainer("alpha", "child-id\topenshell-alpha-child\n", [
        "alpha",
        "alpha-child",
      ]),
    ).toThrow(/labels and names disagree.*refusing lifecycle execution/);
  });

  it("builds privileged docker exec argv through the registered direct sandbox container", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "vm" }),
        listSandboxes: () => ({
          sandboxes: [{ name: "alpha" }, { name: "alpha-child" }],
          defaultSandbox: "alpha",
        }),
        dockerCapture: () => "immutable-alpha-id\topenshell-alpha-abc123\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(privilegedSandboxExecArgv("alpha", ["id"], true)).toEqual([
          "exec",
          "-i",
          "--user",
          "root",
          "immutable-alpha-id",
          "id",
        ]);
      },
    );
  });

  it("bounds direct sandbox container discovery", () => {
    const discoveryCalls: Array<{
      args: readonly string[];
      timeout: number | undefined;
    }> = [];

    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: (args, options) => {
          discoveryCalls.push({ args, timeout: options?.timeout });
          return "immutable-alpha-id\topenshell-alpha\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(privilegedSandboxExecArgv("alpha", ["id"])).toEqual([
          "exec",
          "--user",
          "root",
          "immutable-alpha-id",
          "id",
        ]);
      },
    );

    expect(discoveryCalls).toEqual([
      {
        args: [
          "ps",
          "--no-trunc",
          "--filter",
          "label=openshell.ai/managed-by=openshell",
          "--filter",
          "label=openshell.ai/sandbox-name=alpha",
          "--format",
          "{{.ID}}\t{{.Names}}",
        ],
        timeout: 5000,
      },
    ]);
  });

  it("clears interpreter and dynamic-loader injection variables for root control", () => {
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "docker" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => "immutable-alpha-id\topenshell-alpha\n",
      },
      ({ privilegedSandboxExecArgv }) => {
        const argv = privilegedSandboxExecArgv("alpha", ["/trusted/control"], false, true);
        expect(argv.slice(0, 1)).toEqual(["exec"]);
        expect(argv).toContain("LD_PRELOAD=");
        expect(argv).toContain("LD_LIBRARY_PATH=");
        expect(argv).toContain("LD_AUDIT=");
        expect(argv).toContain("PYTHONPATH=");
        expect(argv).toContain("PYTHONUSERBASE=");
        expect(argv).toContain("PYTHONNOUSERSITE=1");
        expect(argv).toContain("BASH_ENV=");
        expect(argv.slice(-4)).toEqual([
          "--user",
          "root",
          "immutable-alpha-id",
          "/trusted/control",
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
          return "child-id\topenshell-alpha-child\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow("registry corrupt");
      },
    );
    expect(dockerPsCalls).toBe(0);
  });

  it("rejects a Kubernetes registry owner before stale local-container discovery", () => {
    let dockerPsCalls = 0;
    withPrivilegedExecMocks(
      {
        getSandbox: () => ({ name: "alpha", openshellDriver: "kubernetes" }),
        listSandboxes: () => ({ sandboxes: [{ name: "alpha" }], defaultSandbox: "alpha" }),
        dockerCapture: () => {
          dockerPsCalls += 1;
          return "stale-id\topenshell-alpha-stale\n";
        },
      },
      ({ privilegedSandboxExecArgv }) => {
        expect(() => privilegedSandboxExecArgv("alpha", ["id"])).toThrow(
          /driver: kubernetes.*refusing local Docker discovery/i,
        );
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
          return "child-id\topenshell-alpha-child\n";
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
        dockerCapture: () => "",
      },
      ({ isDirectSandboxFallbackUnavailableError, privilegedSandboxExecArgv }) => {
        let refusal: unknown;
        try {
          privilegedSandboxExecArgv("alpha", ["id"]);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(Error);
        expect(String(refusal)).toMatch(
          /No running direct OpenShell sandbox container found for 'alpha'/,
        );
        expect(isDirectSandboxFallbackUnavailableError(refusal)).toBe(true);
      },
    );
  });
});
