// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerCapture: vi.fn(),
  dockerSpawnSync: vi.fn(),
}));

vi.mock("../../adapters/docker/run", () => ({ dockerCapture: mocks.dockerCapture }));
vi.mock("../../adapters/docker/exec", () => ({ dockerSpawnSync: mocks.dockerSpawnSync }));

import { createDockerPrivilegedSandboxControl } from "./docker-privileged-sandbox-control";

const CONTAINER_ID = "a".repeat(64);

function exactInspect(running = true, sandboxName = "alpha", role?: string): string {
  return [
    CONTAINER_ID,
    `/openshell-default--${sandboxName}-sandbox-id`,
    String(running),
    JSON.stringify({
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/sandbox-name": sandboxName,
      ...(role === undefined ? {} : { "openshell.ai/isolation-role": role }),
    }),
  ].join("\t");
}

describe("Docker privileged exact target", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores workspace metadata through exact-ID archive copy without adding capabilities", () => {
    mocks.dockerCapture.mockReturnValue(exactInspect());
    const observed = { uid: 999, gid: 999, mode: 0o700, dev: 1, ino: 2, mtime: 3 };
    mocks.dockerSpawnSync
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify(observed)),
        stderr: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify({ ...observed, uid: 0, mode: 0o1775 })),
        stderr: Buffer.alloc(0),
      });
    createDockerPrivilegedSandboxControl().prepareManagedStartupWorkspace!({
      sandbox: { name: "alpha", openshellDriver: "docker" },
      sandboxName: "alpha",
      registeredSandboxNames: ["alpha"],
      expectedResourceHandle: CONTAINER_ID,
      timeoutMs: 30000,
      workspace: { uid: 0, gid: 999, mode: 0o1775 },
    });
    expect(mocks.dockerCapture).toHaveBeenCalledTimes(3);
    const [copyArgs, copyOptions] = mocks.dockerSpawnSync.mock.calls[1]!;
    expect(copyArgs).toEqual(["cp", "-", `${CONTAINER_ID}:/`]);
    expect(copyOptions.input.byteLength).toBe(1536);
    const allArguments = mocks.dockerSpawnSync.mock.calls.flatMap(([args]) => args);
    expect(allArguments).not.toContain("--privileged");
    expect(allArguments).not.toContain("--cap-add");
  });

  it("refuses the workspace copy when the pinned runtime stops after observation", () => {
    mocks.dockerCapture.mockReturnValueOnce(exactInspect()).mockReturnValue(exactInspect(false));
    mocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: Buffer.from(
        JSON.stringify({ uid: 999, gid: 999, mode: 0o700, dev: 1, ino: 2, mtime: 3 }),
      ),
      stderr: Buffer.alloc(0),
    });
    expect(() =>
      createDockerPrivilegedSandboxControl().prepareManagedStartupWorkspace!({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        expectedResourceHandle: CONTAINER_ID,
        timeoutMs: 30000,
        workspace: { uid: 0, gid: 999, mode: 0o1775 },
      }),
    ).toThrow(/identity changed/u);
    expect(mocks.dockerSpawnSync).toHaveBeenCalledOnce();
  });

  it("bounds direct target discovery by the caller's remaining deadline", () => {
    mocks.dockerCapture.mockReturnValue(
      `${CONTAINER_ID}\topenshell-default--alpha-sandbox-id\tsandbox\n` +
        `${"b".repeat(64)}\topenshell-default--alpha-sandbox-id-supervisor\tsupervisor`,
    );
    const control = createDockerPrivilegedSandboxControl();

    expect(
      control.resolveTarget({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        timeoutMs: 1_250,
      }),
    ).toEqual({ providerId: "docker", resourceHandle: CONTAINER_ID });
    expect(mocks.dockerCapture).toHaveBeenCalledWith(
      expect.arrayContaining([
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "openshell.ai/isolation-role"}}',
      ]),
      { timeout: 1_250 },
    );
  });

  it.each([undefined, "sandbox"])(
    "executes in the pinned workload with role %s (#11905)",
    (role) => {
      mocks.dockerCapture.mockReturnValue(exactInspect(true, "alpha", role));
      const control = createDockerPrivilegedSandboxControl();

      expect(
        control.buildLegacyDockerArgv?.({
          sandbox: { name: "alpha", openshellDriver: "docker" },
          sandboxName: "alpha",
          registeredSandboxNames: ["alpha"],
          command: ["true"],
          expectedResourceHandle: CONTAINER_ID,
          sanitizeEnvironment: false,
        }),
      ).toEqual(["exec", "--user", "root", CONTAINER_ID, "true"]);
      expect(mocks.dockerCapture).toHaveBeenCalledWith(
        expect.arrayContaining(["inspect", CONTAINER_ID]),
        expect.any(Object),
      );
    },
  );

  it.each([
    ["stopped", exactInspect(false)],
    ["wrong sandbox", exactInspect(true, "replacement")],
    ["supervisor", exactInspect(true, "alpha", "supervisor")],
    ["unknown role", exactInspect(true, "alpha", "other")],
  ])("rejects a %s pinned target", (_label, inspect) => {
    mocks.dockerCapture.mockReturnValue(inspect);
    const control = createDockerPrivilegedSandboxControl();

    expect(() =>
      control.buildLegacyDockerArgv?.({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        command: ["true"],
        expectedResourceHandle: CONTAINER_ID,
        sanitizeEnvironment: false,
      }),
    ).toThrow(/identity changed/u);
  });

  it("executes native-home cleanup as the pinned nonroot owner without added capabilities", () => {
    mocks.dockerCapture.mockReturnValue(exactInspect());
    mocks.dockerSpawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: Buffer.from("done"),
      stderr: Buffer.alloc(0),
    });
    const control = createDockerPrivilegedSandboxControl();
    const input = Buffer.from("synthetic input");

    expect(
      control.executeAsSandboxUser?.({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        expectedResourceHandle: CONTAINER_ID,
        sandboxUser: "999:999",
        command: ["/usr/bin/true"],
        sanitizeEnvironment: true,
        input,
        timeoutMs: 1234,
        maxOutputBytes: 4096,
      }),
    ).toEqual({ status: 0, signal: null, stdout: Buffer.from("done"), stderr: Buffer.alloc(0) });
    const [argv, options] = mocks.dockerSpawnSync.mock.calls[0]!;
    expect(argv.slice(-4)).toEqual(["--user", "999:999", CONTAINER_ID, "/usr/bin/true"]);
    expect(argv.slice(0, 2)).toEqual(["exec", "-i"]);
    expect(argv).toContain("--env");
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("--cap-add");
    expect(options).toEqual({
      encoding: null,
      input,
      maxBuffer: 4096,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 1234,
    });
    expect(mocks.dockerCapture).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(["inspect", CONTAINER_ID]),
      expect.any(Object),
    );
  });

  it.each(["0:999", "999:0", "root", "sandbox", "--privileged", "999:999\n"])(
    "rejects unsafe sandbox identity %j before engine access",
    (sandboxUser) => {
      const control = createDockerPrivilegedSandboxControl();
      expect(() =>
        control.executeAsSandboxUser?.({
          sandbox: { name: "alpha", openshellDriver: "docker" },
          sandboxName: "alpha",
          registeredSandboxNames: ["alpha"],
          expectedResourceHandle: CONTAINER_ID,
          sandboxUser,
          command: ["true"],
          sanitizeEnvironment: true,
          timeoutMs: 1000,
        }),
      ).toThrow(/non-root numeric UID and GID/u);
      expect(mocks.dockerCapture).not.toHaveBeenCalled();
      expect(mocks.dockerSpawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([
    exactInspect(false),
    exactInspect(true, "replacement"),
    exactInspect(true, "alpha", "supervisor"),
  ])("refuses sandbox-user execution after target identity changes", (inspect) => {
    mocks.dockerCapture.mockReturnValue(inspect);
    const control = createDockerPrivilegedSandboxControl();
    expect(() =>
      control.executeAsSandboxUser?.({
        sandbox: { name: "alpha", openshellDriver: "docker" },
        sandboxName: "alpha",
        registeredSandboxNames: ["alpha"],
        expectedResourceHandle: CONTAINER_ID,
        sandboxUser: "999:999",
        command: ["true"],
        sanitizeEnvironment: true,
        timeoutMs: 1000,
      }),
    ).toThrow(/identity changed/u);
    expect(mocks.dockerSpawnSync).not.toHaveBeenCalled();
  });
});
