// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  queryOpenShellDockerSandboxRuntimeSnapshot,
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
      removeExactOpenShellDockerSandboxContainers(
        "alpha",
        [expectedContainerId],
        vi.fn(),
        { inspectContainers, forceRemove },
      ),
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

    removeExactOpenShellDockerSandboxContainers(
      "alpha",
      expectedContainerIds,
      vi.fn(),
      { inspectContainers, forceRemove },
    );

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

    removeExactOpenShellDockerSandboxContainers(
      "alpha",
      [alreadyRemovedId, remainingId],
      vi.fn(),
      { inspectContainers, forceRemove },
    );

    expect(forceRemove).toHaveBeenCalledExactlyOnceWith(remainingId);
    expect(currentContainerIds).toEqual([]);
  });

  it("does not remove a container outside the retained identity set (#10547)", () => {
    const expectedContainerId = "a".repeat(64);
    const replacementContainerId = "b".repeat(64);
    const forceRemove = vi.fn(() => ({ status: 0 }));

    expect(() =>
      removeExactOpenShellDockerSandboxContainers(
        "alpha",
        [expectedContainerId],
        vi.fn(),
        {
          inspectContainers: vi.fn(() => observeContainerIds([replacementContainerId])),
          forceRemove,
        },
      ),
    ).toThrow("refusing replacement cleanup");

    expect(forceRemove).not.toHaveBeenCalled();
  });

  it("rejects malformed Docker identity output during exact cleanup (#10547)", () => {
    const expectedContainerId = "a".repeat(64);
    const forceRemove = vi.fn(() => ({ status: 0 }));

    expect(() =>
      removeExactOpenShellDockerSandboxContainers(
        "alpha",
        [expectedContainerId],
        vi.fn(),
        {
          inspectContainers: vi.fn(() => observeContainerIds([], 1)),
          forceRemove,
        },
      ),
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

describe("queryOpenShellDockerSandboxRuntimeSnapshot", () => {
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
