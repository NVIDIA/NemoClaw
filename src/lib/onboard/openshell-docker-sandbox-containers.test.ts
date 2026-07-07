// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { queryOpenShellDockerSandboxRuntimeSnapshot } from "./openshell-docker-sandbox-containers";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const BOOKKEEPING_IMAGE_REF = "openshell/sandbox-from:alpha";
const EMPTY_RUNTIME_FIELDS = [IMAGE_ID, BOOKKEEPING_IMAGE_REF, "", null, [], "runc"];

function querySnapshot(fields: unknown) {
  const dockerRun = vi
    .fn()
    .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(fields), stderr: "" });
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
      nativeGpuAttachmentState: "present",
    });
  });

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
  ])("keeps well-formed open-world GPU configuration %s unknown", (_label, requests, devices, runtime) => {
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
  });

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
