// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { queryOpenShellDockerSandboxImage } from "./openshell-docker-sandbox-containers";

describe("queryOpenShellDockerSandboxImage", () => {
  it("resolves a reusable image only from one status-bearing labeled-container result", () => {
    const dockerRun = vi.fn((args: readonly string[]) =>
      args[0] === "ps"
        ? { status: 0, stdout: "container-a\n", stderr: "" }
        : { status: 0, stdout: "openshell/sandbox-from:123\n", stderr: "" },
    );

    expect(queryOpenShellDockerSandboxImage("alpha", { dockerRun })).toEqual({
      ok: true,
      imageRef: "openshell/sandbox-from:123",
      containerId: "container-a",
    });
    expect(dockerRun).toHaveBeenLastCalledWith(
      ["inspect", "--type", "container", "--format", "{{.Config.Image}}", "container-a"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("refuses an image reference when labeled-container state is ambiguous", () => {
    const dockerRun = vi.fn(() => ({
      status: 0,
      stdout: "container-a\ncontainer-b\n",
      stderr: "",
    }));

    expect(queryOpenShellDockerSandboxImage("alpha", { dockerRun })).toEqual({
      ok: false,
      error: "expected one labeled sandbox container, found 2",
    });
    expect(dockerRun).toHaveBeenCalledOnce();
  });

  it("refuses malformed inspect output while preserving custom registry and digest references", () => {
    const dockerRun = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "registry.example:5000/team/image@sha256:abc\n" });

    expect(queryOpenShellDockerSandboxImage("alpha", { dockerRun })).toEqual({
      ok: true,
      imageRef: "registry.example:5000/team/image@sha256:abc",
      containerId: "container-a",
    });

    dockerRun
      .mockReturnValueOnce({ status: 0, stdout: "container-a\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "image:tag embedded-value\n", stderr: "" });
    expect(queryOpenShellDockerSandboxImage("alpha", { dockerRun })).toEqual({
      ok: false,
      error: "image:tag embedded-value",
    });
  });
});
