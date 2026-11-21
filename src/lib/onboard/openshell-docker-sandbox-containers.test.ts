// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  queryOpenShellDockerSandboxRuntimeSnapshot,
  captureOpenShellDockerSandboxFailureOutput,
  resolveOpenShellSandboxOwnershipLabel,
  removeExactOpenShellDockerSandboxContainers,
} from "./openshell-docker-sandbox-containers";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const BOOKKEEPING_IMAGE_REF = "openshell/sandbox-from:alpha";
const EMPTY_RUNTIME_FIELDS = [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [], "runc"];
const ACTIVATED_CONTAINER_ID = "b".repeat(64);
const ROLLBACK_CONTAINER_ID = "c".repeat(64);

describe("resolveOpenShellSandboxOwnershipLabel", () => {
  it("keeps Docker compatibility ownership independent of native provider selection", () => {
    expect(resolveOpenShellSandboxOwnershipLabel({})).toEqual({
      label: "openshell.ai/managed-by",
      value: "openshell",
    });
    expect(resolveOpenShellSandboxOwnershipLabel({ NEMOCLAW_GATEWAY_RUNTIME: "podman" })).toEqual({
      label: "openshell.ai/managed-by",
      value: "openshell",
    });
  });
});

function observeContainerIds(ids: readonly string[], malformedRows = 0) {
  return {
    status: "observed" as const,
    rows: ids.map((id) => ({
      id,
      managedBy: "openshell",
      workspace: "default",
      sandboxId: "sb-alpha",
    })),
    malformedRows,
  };
}

describe("removeExactOpenShellDockerSandboxContainers", () => {
  it("fails when Docker cannot confirm the exact container is absent after removal (#9073)", () => {
    const expectedContainerId = "a".repeat(64);
    const inspectContainers = vi
      .fn()
      .mockReturnValueOnce(observeContainerIds([expectedContainerId]))
      .mockReturnValueOnce(observeContainerIds([expectedContainerId]));
    const forceRemove = vi.fn(() => ({ status: 0 }));

    expect(() =>
      removeExactOpenShellDockerSandboxContainers("alpha", [expectedContainerId], vi.fn(), {
        inspectContainers,
        forceRemove,
      }),
    ).toThrow("could not confirm exact Docker container removal");

    expect(forceRemove).toHaveBeenCalledWith(expectedContainerId);
  });

  it("removes every remaining container from one exact failed attempt (#10547)", () => {
    const expectedContainerIds = ["a".repeat(64), "b".repeat(64)];
    let currentContainerIds = [...expectedContainerIds];
    const inspectContainers = vi.fn(() => observeContainerIds(currentContainerIds));
    const forceRemove = vi.fn((containerId: string) => {
      currentContainerIds = currentContainerIds.filter((candidate) => candidate !== containerId);
      return { status: 0 };
    });

    removeExactOpenShellDockerSandboxContainers("alpha", expectedContainerIds, vi.fn(), {
      inspectContainers,
      forceRemove,
    });

    expect(forceRemove.mock.calls.map(([containerId]) => containerId)).toEqual(
      expectedContainerIds,
    );
    expect(currentContainerIds).toEqual([]);
  });

  it("continues cleanup when an earlier exact container is already absent (#10547)", () => {
    const alreadyRemovedId = "a".repeat(64);
    const remainingId = "b".repeat(64);
    let currentContainerIds = [remainingId];
    const inspectContainers = vi.fn(() => observeContainerIds(currentContainerIds));
    const forceRemove = vi.fn((containerId: string) => {
      currentContainerIds = currentContainerIds.filter((candidate) => candidate !== containerId);
      return { status: 0 };
    });

    removeExactOpenShellDockerSandboxContainers("alpha", [alreadyRemovedId, remainingId], vi.fn(), {
      inspectContainers,
      forceRemove,
    });

    expect(forceRemove).toHaveBeenCalledExactlyOnceWith(remainingId);
    expect(currentContainerIds).toEqual([]);
  });

  it("does not remove a container outside the retained identity set (#10547)", () => {
    const expectedContainerId = "a".repeat(64);
    const replacementContainerId = "b".repeat(64);
    const forceRemove = vi.fn(() => ({ status: 0 }));

    expect(() =>
      removeExactOpenShellDockerSandboxContainers("alpha", [expectedContainerId], vi.fn(), {
        inspectContainers: vi.fn(() => observeContainerIds([replacementContainerId])),
        forceRemove,
      }),
    ).toThrow("refusing replacement cleanup");

    expect(forceRemove).not.toHaveBeenCalled();
  });

  it("rejects malformed Docker identity output during exact cleanup (#10547)", () => {
    const expectedContainerId = "a".repeat(64);
    const forceRemove = vi.fn(() => ({ status: 0 }));

    expect(() =>
      removeExactOpenShellDockerSandboxContainers("alpha", [expectedContainerId], vi.fn(), {
        inspectContainers: vi.fn(() => observeContainerIds([], 1)),
        forceRemove,
      }),
    ).toThrow("malformed container identity row");

    expect(forceRemove).not.toHaveBeenCalled();
  });
});

function querySnapshot(fields: unknown, nvidiaVisibleDevices?: string) {
  const dockerRun = vi
    .fn()
    .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(fields), stderr: "" })
    .mockReturnValueOnce({
      status: 0,
      stdout:
        nvidiaVisibleDevices === undefined
          ? ""
          : `NVIDIA_VISIBLE_DEVICES=${nvidiaVisibleDevices}\n`,
      stderr: "",
    });
  return {
    dockerRun,
    result: queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun }),
  };
}

// Preserve startup output when create fails before sandbox status is readable
// and rollback removes the container (#13178).
describe("captureOpenShellDockerSandboxFailureOutput (#13178)", () => {
  const CONTAINER_ID = "f".repeat(64);
  const identity = (id: string, role = "") =>
    [id, "openshell", role === "supervisor" ? "" : "default", "sandbox-id", "namespace", role].join(
      "\t",
    );
  const STARTUP_FAILURE =
    "Error:   × Failed to prepare sandbox: Landlock path unavailable in hard_requirement mode";
  const dockerResult = (stdout: string, status = 0, stderr = "") =>
    ({ status, stdout, stderr }) as never;
  const inspectWithEnv = (env: string[]) => JSON.stringify([{ Config: { Env: env }, State: {} }]);

  it("reads redacted output from the one OpenShell container labeled with the sandbox name", () => {
    const opaqueSecret = "opaque-value-9f8e7d6c5b4a";
    const dockerRun = vi.fn((_args: readonly string[], _options?: { timeout?: number }) =>
      dockerResult(`${identity(CONTAINER_ID)}\n`),
    );
    const dockerCapture = vi.fn((args: readonly string[]) =>
      args.includes("--format") ? "" : inspectWithEnv([`PROVIDER_TOKEN=${opaqueSecret}`]),
    );
    const dockerLogs = vi.fn(() => `provider said ${opaqueSecret}\n${STARTUP_FAILURE}`);

    const output = captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
      dockerRun,
      dockerCapture,
      dockerLogs,
      expectedSandboxId: "sandbox-id",
    });

    expect(dockerRun.mock.calls[0][0]).toEqual(
      expect.arrayContaining(["label=openshell.ai/sandbox-name=my-assistant"]),
    );
    expect(dockerLogs).toHaveBeenCalledWith(CONTAINER_ID, expect.anything());
    // A stalled lookup must not hold the failed sandbox before rollback.
    expect(dockerRun.mock.calls[0][1]).toMatchObject({ timeout: 2_000 });
    expect(output).toContain(STARTUP_FAILURE);
    expect(output).not.toContain(opaqueSecret);
  });

  it.each([null, CONTAINER_ID])(
    "refuses logs from a changed sandbox identity with runtime %s",
    (expectedContainerId) => {
      const dockerRun = vi.fn(() => dockerResult(`${identity(CONTAINER_ID)}\n`));
      const dockerCapture = vi.fn();
      const dockerLogs = vi.fn();
      expect(
        captureOpenShellDockerSandboxFailureOutput("my-assistant", expectedContainerId, {
          dockerRun,
          dockerCapture,
          dockerLogs,
          expectedSandboxId: "different-sandbox-id",
        }),
      ).toBeNull();
      expect(dockerCapture).not.toHaveBeenCalled();
      expect(dockerLogs).not.toHaveBeenCalled();
    },
  );

  it("starts no Docker call after the shared capture deadline before rollback", () => {
    let clock = 1_000;
    const dockerRun = vi.fn((_args: readonly string[], options?: { timeout?: number }) => {
      clock += options?.timeout ?? 0;
      return dockerResult(`${identity(CONTAINER_ID)}\n`);
    });
    const dockerCapture = vi.fn((_args: readonly string[], options?: { timeout?: number }) => {
      clock += options?.timeout ?? 0;
      return "";
    });
    const dockerLogs = vi.fn();

    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
        dockerRun,
        dockerCapture,
        dockerLogs,
        now: () => clock,
      }),
    ).toBeNull();
    expect(dockerRun.mock.calls[0][1]).toMatchObject({ timeout: 2_000 });
    expect(dockerCapture).toHaveBeenCalledOnce();
    expect(dockerCapture.mock.calls[0][1]).toMatchObject({ timeout: 2_000 });
    expect(dockerLogs).not.toHaveBeenCalled();
    expect(clock - 1_000).toBeLessThanOrEqual(4_000);
  });

  it.each(["opaque-private-token", "opaque-" + "z".repeat(1600) + "-secret"])(
    "learns both role inventories before truncating any log",
    (secret) => {
      const supervisor = "e".repeat(64);
      const dockerLogs = vi.fn((id: string) => `${id}: ${secret}\n${STARTUP_FAILURE}`);
      const output = captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
        dockerRun: vi.fn(() =>
          dockerResult(
            [identity(CONTAINER_ID, "sandbox"), identity(supervisor, "supervisor")].join("\n"),
          ),
        ),
        dockerCapture: () =>
          JSON.stringify([
            { Id: CONTAINER_ID, Config: { Env: [] }, State: {} },
            {
              Id: supervisor,
              Config: {
                Env: [
                  `OPENSHELL_MAIN_PROCESS_SPEC=${JSON.stringify({ version: 1, command: ["env", `TOKEN=${secret}`, "nemoclaw-start"], tty: false, await_main_process_attachment: false })}`,
                ],
              },
              State: {},
            },
          ]),
        dockerLogs,
      });
      expect(dockerLogs.mock.calls.map(([id]) => id)).toEqual([CONTAINER_ID, supervisor]);
      expect(output).toContain("== supervisor");
      expect(output).toContain("== sandbox");
      expect(output).toContain(STARTUP_FAILURE);
      expect(output).not.toContain(secret);
      expect(output).not.toContain("z".repeat(20));
    },
  );

  it.each([
    ["incomplete inventory", []],
    ["foreign ID", [{ Id: "b".repeat(64), Config: { Env: [] } }]],
    ["missing environment", [{ Id: "e".repeat(64), Config: {} }]],
    ["duplicate ID", [{ Id: CONTAINER_ID, Config: { Env: [] } }]],
  ])("reads no role logs with %s", (_reason, remainder) => {
    const dockerLogs = vi.fn();
    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
        dockerRun: () =>
          dockerResult(
            [identity(CONTAINER_ID, "sandbox"), identity("e".repeat(64), "supervisor")].join("\n"),
          ),
        dockerCapture: () =>
          JSON.stringify([{ Id: CONTAINER_ID, Config: { Env: [] } }, ...remainder]),
        dockerLogs,
      }),
    ).toBeNull();
    expect(dockerLogs).not.toHaveBeenCalled();
  });

  it("retains bounded role state with empty logs without copying inspect secrets", () => {
    const supervisor = "e".repeat(64);
    const output = captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
      dockerRun: () =>
        dockerResult(
          [identity(CONTAINER_ID, "sandbox"), identity(supervisor, "supervisor")].join("\n"),
        ),
      dockerCapture: () =>
        JSON.stringify([
          {
            Id: CONTAINER_ID,
            Config: { Env: ["TOKEN=private-inspect-secret"] },
            State: {
              Running: false,
              ExitCode: 7,
              OOMKilled: true,
              Error: "private-inspect-secret",
            },
          },
          {
            Id: supervisor,
            Config: { Env: [] },
            State: { Running: true, ExitCode: "private-inspect-secret", OOMKilled: false },
          },
        ]),
      dockerLogs: () => "",
    });
    expect(output).toBe(
      `== sandbox ${CONTAINER_ID} ==\nrunning=false exit_code=7 oom_killed=true\n` +
        `== supervisor ${supervisor} ==\nrunning=true oom_killed=false`,
    );
  });

  it("reads no role logs when the complete inspect inventory exceeds the shared deadline", () => {
    let clock = 0;
    const dockerLogs = vi.fn();
    const output = captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
      now: () => clock,
      dockerRun: vi.fn((_args, options) => {
        clock += options?.timeout ?? 0;
        return dockerResult(
          [identity(CONTAINER_ID, "sandbox"), identity("e".repeat(64), "supervisor")].join("\n"),
        );
      }),
      dockerCapture: vi.fn((_args, options) => {
        clock += options?.timeout ?? 0;
        return JSON.stringify([
          { Id: CONTAINER_ID, Config: { Env: [] } },
          { Id: "e".repeat(64), Config: { Env: [] } },
        ]);
      }),
      dockerLogs,
    });
    expect(output).toBeNull();
    expect(dockerLogs).not.toHaveBeenCalled();
    expect(clock).toBe(4000);
  });

  it.each([
    ["different sandbox", identity("e".repeat(64), "supervisor").replace("sandbox-id", "other")],
    ["different namespace", identity("e".repeat(64), "supervisor").replace("namespace", "other")],
    [
      "different workspace",
      identity("e".repeat(64), "supervisor").replace("\t\tsandbox-id", "\tother\tsandbox-id"),
    ],
    ["foreign owner", identity("e".repeat(64), "supervisor").replace("openshell", "foreign")],
    ["duplicate role", identity("e".repeat(64), "sandbox")],
    ["duplicate identity", identity(CONTAINER_ID, "supervisor")],
    ["missing namespace", identity("e".repeat(64), "supervisor").replace("namespace", "")],
    ["malformed identity", "malformed"],
  ])("refuses native diagnostics with %s", (_name, second) => {
    const dockerLogs = vi.fn();
    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
        dockerRun: vi.fn(() =>
          dockerResult([identity(CONTAINER_ID, "sandbox"), second].join("\n")),
        ),
        dockerLogs,
      }),
    ).toBeNull();
    expect(dockerLogs).not.toHaveBeenCalled();
  });

  it("reads the exact failed replacement without a label lookup", () => {
    const dockerRun = vi.fn();
    const dockerLogs = vi.fn(() => STARTUP_FAILURE);

    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", CONTAINER_ID, {
        dockerRun,
        dockerCapture: () => inspectWithEnv([]),
        dockerLogs,
      }),
    ).toBe(STARTUP_FAILURE);
    expect(dockerRun).not.toHaveBeenCalled();
    expect(dockerLogs).toHaveBeenCalledWith(CONTAINER_ID, expect.anything());
  });

  it.each([
    ["no labeled container", dockerResult("")],
    ["several labeled containers", dockerResult(`${CONTAINER_ID}\n${"e".repeat(64)}\n`)],
    ["a failed Docker query", dockerResult("", 1, "Cannot connect to the Docker daemon")],
  ])("captures nothing when Docker reports %s", (_scenario, psResult) => {
    const dockerLogs = vi.fn();

    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", null, {
        dockerRun: vi.fn(() => psResult),
        dockerCapture: () => "",
        dockerLogs,
      }),
    ).toBeNull();
    expect(dockerLogs).not.toHaveBeenCalled();
  });

  it("captures nothing when docker logs fails", () => {
    expect(
      captureOpenShellDockerSandboxFailureOutput("my-assistant", CONTAINER_ID, {
        dockerCapture: () => "",
        dockerLogs: () => {
          throw new Error("No such container");
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      "fails",
      () => {
        throw new Error("inspect failed");
      },
    ],
    ["returns malformed output", () => "not json"],
    ["omits the container environment", () => JSON.stringify([{}])],
  ])(
    "captures nothing when container inspect %s, so opaque values cannot leak",
    (_scenario, inspect) => {
      const opaqueSecret = "opaque-value-9f8e7d6c5b4a";

      expect(
        captureOpenShellDockerSandboxFailureOutput("my-assistant", CONTAINER_ID, {
          dockerCapture: inspect,
          dockerLogs: () => `provider said ${opaqueSecret}\n${STARTUP_FAILURE}`,
        }),
      ).toBeNull();
    },
  );
});

describe("queryOpenShellDockerSandboxRuntimeSnapshot", () => {
  it.each([
    {
      label: "one workload and its supervisor",
      roles: ["sandbox", "supervisor"],
      expected: { ok: true, containerId: "1".repeat(64) },
      calls: 2,
    },
    {
      label: "only a supervisor",
      roles: ["supervisor"],
      expected: { ok: false, error: "expected one labeled sandbox container, found 0" },
      calls: 1,
    },
    {
      label: "two workloads and a supervisor",
      roles: ["sandbox", "sandbox", "supervisor"],
      expected: { ok: false, error: "expected one labeled sandbox container, found 2" },
      calls: 1,
    },
  ])("requires one workload when Docker contains $label", ({ roles, expected, calls }) => {
    const containers = roles.map((role, index) => ({
      id: String(index + 1).repeat(64),
      labels: [
        "openshell.ai/managed-by=openshell",
        "openshell.ai/sandbox-name=alpha",
        `openshell.ai/isolation-role=${role}`,
      ],
    }));
    const dockerRun = vi
      .fn()
      .mockImplementationOnce((args: readonly string[]) => {
        const labels = args.filter((arg) => arg.startsWith("label=")).map((arg) => arg.slice(6));
        const ids = containers
          .filter((container) => labels.every((label) => container.labels.includes(label)))
          .map((container) => container.id);
        return { status: 0, stdout: ids.join("\n"), stderr: "" };
      })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(EMPTY_RUNTIME_FIELDS), stderr: "" });

    expect(queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun })).toMatchObject(
      expected,
    );
    expect(dockerRun).toHaveBeenCalledTimes(calls);
  });

  it("does not start container discovery after the shared deadline expires", () => {
    const dockerRun = vi.fn();
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValue(1_001);

    expect(
      queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun }, { timeoutMs: 1, now }),
    ).toEqual({ ok: false, error: "Docker sandbox query deadline expired" });
    expect(dockerRun).not.toHaveBeenCalled();
  });

  it("reuses the validated remaining deadline for container inspection", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(EMPTY_RUNTIME_FIELDS), stderr: "" });
    const now = vi
      .fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_001);

    expect(
      queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun }, { timeoutMs: 1, now }),
    ).toEqual(expect.objectContaining({ ok: true, containerId: "container-a" }));
    expect(dockerRun).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(["inspect", "container-a"]),
      expect.objectContaining({ timeout: 1 }),
    );
  });

  it("returns immutable identity, bookkeeping ref, and safe absence from one exact container", () => {
    const { dockerRun, result } = querySnapshot(EMPTY_RUNTIME_FIELDS);

    expect(result).toEqual({
      ok: true,
      imageId: IMAGE_ID,
      bookkeepingImageRef: BOOKKEEPING_IMAGE_REF,
      stateError: "",
      deviceRequests: null,
      devices: [],
      runtime: "runc",
      nvidiaVisibleDevices: null,
      nativeGpuAttachmentState: "absent",
      containerId: "container-a",
    });
    expect(dockerRun).toHaveBeenLastCalledWith(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        "[{{json .Image}},{{json .Config.Image}},{{json .State.Error}},{{json .HostConfig.DeviceRequests}},{{json .HostConfig.Devices}},{{json .HostConfig.Runtime}}]",
        "container-a",
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it.each([
    [
      "Docker GPU capability request",
      [
        {
          Driver: "",
          Count: -1,
          DeviceIDs: null,
          Capabilities: [["gpu"]],
          Options: {},
        },
      ],
      [],
      "runc",
    ],
    [
      "NVIDIA CDI request",
      [
        {
          Driver: "cdi",
          Count: 0,
          DeviceIDs: ["nvidia.com/gpu=all"],
          Capabilities: null,
          Options: {},
        },
      ],
      [],
      "runc",
    ],
    [
      "direct NVIDIA device",
      null,
      [
        {
          PathOnHost: "/dev/nvidia0",
          PathInContainer: "/dev/nvidia0",
          CgroupPermissions: "rwm",
        },
      ],
      "runc",
    ],
    [
      "DRI device",
      null,
      [
        {
          PathOnHost: "/dev/dri/renderD128",
          PathInContainer: "/dev/dri/renderD128",
          CgroupPermissions: "rwm",
        },
      ],
      "runc",
    ],
    [
      "Jetson device",
      null,
      [
        {
          PathOnHost: "/dev/nvhost-gpu",
          PathInContainer: "/dev/nvhost-gpu",
          CgroupPermissions: "rwm",
        },
      ],
      "runc",
    ],
    ["NVIDIA runtime", null, [], "nvidia"],
  ])("detects a host-configured GPU attachment from %s", (_label, requests, devices, runtime) => {
    const { result } = querySnapshot(
      [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", requests, devices, runtime],
      runtime === "nvidia" ? "all" : undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      nativeGpuAttachmentState: "present",
    });
  });

  it.each([
    ["all devices", "all", "present"],
    ["an exact device list", "0,GPU-live-1", "present"],
    ["no devices", "none", "absent"],
    ["runtime bypass", "void", "absent"],
  ] as const)("reads only NVIDIA_VISIBLE_DEVICES for %s", (_label, value, expectedState) => {
    const { dockerRun, result } = querySnapshot(
      [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [], "nvidia"],
      value,
    );

    expect(result).toMatchObject({
      ok: true,
      nvidiaVisibleDevices: value,
      nativeGpuAttachmentState: expectedState,
    });
    expect(dockerRun).toHaveBeenLastCalledWith(
      [
        "inspect",
        "--type",
        "container",
        "--format",
        '{{range .Config.Env}}{{if eq (index (split . "=") 0) "NVIDIA_VISIBLE_DEVICES"}}{{println .}}{{end}}{{end}}',
        "container-a",
      ],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it.each(["all,0", "0,0", "GPU-0 with-space"])(
    "rejects ambiguous NVIDIA_VISIBLE_DEVICES value %s",
    (value) => {
      const { result } = querySnapshot(
        [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [], "nvidia"],
        value,
      );

      expect(result).toEqual({
        ok: false,
        error: "docker inspect returned invalid NVIDIA_VISIBLE_DEVICES",
      });
    },
  );

  it.each([
    ["unknown runtime", null, [], "nvidia-container-runtime"],
    [
      "non-NVIDIA CDI request",
      [
        {
          Driver: "cdi",
          Count: 0,
          DeviceIDs: ["example.com/widget=all"],
          Capabilities: null,
          Options: {},
        },
      ],
      [],
      "runc",
    ],
    [
      "unrecognized direct device",
      null,
      [
        {
          PathOnHost: "/dev/custom-accelerator0",
          PathInContainer: "/dev/custom-accelerator0",
          CgroupPermissions: "rwm",
        },
      ],
      "runc",
    ],
  ])(
    "keeps well-formed open-world GPU configuration %s unknown",
    (_label, requests, devices, runtime) => {
      const { result } = querySnapshot([
        IMAGE_ID,
        BOOKKEEPING_IMAGE_REF,
        "",
        requests,
        devices,
        runtime,
      ]);

      expect(result).toMatchObject({
        ok: true,
        nativeGpuAttachmentState: "unknown",
      });
    },
  );

  it.each([
    ["zero", ""],
    ["multiple", "container-a\ncontainer-b\n"],
  ])("refuses %s labeled containers", (_label, ids) => {
    const dockerRun = vi.fn(() => ({ status: 0, stdout: ids, stderr: "" }));

    expect(queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun })).toEqual({
      ok: false,
      error: `expected one labeled sandbox container, found ${ids ? 2 : 0}`,
    });
    expect(dockerRun).toHaveBeenCalledOnce();
  });

  it("inspects the exact activated container while its rollback backup is retained", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: `${ACTIVATED_CONTAINER_ID}\n${ROLLBACK_CONTAINER_ID}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify(EMPTY_RUNTIME_FIELDS),
        stderr: "",
      });

    expect(
      queryOpenShellDockerSandboxRuntimeSnapshot(
        "alpha",
        { dockerRun },
        { expectedContainerId: ACTIVATED_CONTAINER_ID },
      ),
    ).toMatchObject({
      ok: true,
      containerId: ACTIVATED_CONTAINER_ID,
      nativeGpuAttachmentState: "absent",
    });
    expect(dockerRun).toHaveBeenLastCalledWith(
      expect.arrayContaining([ACTIVATED_CONTAINER_ID]),
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it("refuses when the expected activated container ID is absent from the labeled query", () => {
    const dockerRun = vi.fn(() => ({
      status: 0,
      stdout: `${ROLLBACK_CONTAINER_ID}\n`,
      stderr: "",
    }));

    expect(
      queryOpenShellDockerSandboxRuntimeSnapshot(
        "alpha",
        { dockerRun },
        { expectedContainerId: ACTIVATED_CONTAINER_ID },
      ),
    ).toEqual({
      ok: false,
      error: "expected activated sandbox container was not found among labeled containers",
    });
    expect(dockerRun).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "mutable retry identity",
      ["registry.example/team/image:latest", BOOKKEEPING_IMAGE_REF, "", null, [], "runc"],
    ],
    ["short image ID", ["sha256:abc", BOOKKEEPING_IMAGE_REF, "", null, [], "runc"]],
    ["unsafe bookkeeping ref", [IMAGE_ID, "image:tag with-space", "", null, [], "runc"]],
    ["malformed device requests", [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", [{}], [], "runc"]],
    [
      "malformed GPU capabilities",
      [
        IMAGE_ID,
        BOOKKEEPING_IMAGE_REF,
        "",
        [
          {
            Driver: "",
            Count: -1,
            DeviceIDs: null,
            Capabilities: ["gpu"],
            Options: {},
          },
        ],
        [],
        "runc",
      ],
    ],
    ["malformed device mappings", [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [{}], "runc"]],
    ["malformed runtime", [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [], null]],
    ["wrong field count", [IMAGE_ID, BOOKKEEPING_IMAGE_REF]],
  ])("refuses %s instead of proving GPU attachment absence", (_label, fields) => {
    const { result } = querySnapshot(fields);

    expect(result).toEqual({
      ok: false,
      error: "docker inspect returned malformed runtime metadata",
    });
  });

  it("refuses malformed inspect JSON", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "not-json", stderr: "" });

    expect(queryOpenShellDockerSandboxRuntimeSnapshot("alpha", { dockerRun })).toEqual({
      ok: false,
      error: "docker inspect returned malformed runtime metadata",
    });
  });
});
