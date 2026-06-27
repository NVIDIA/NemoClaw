// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const modulePath = "./doctor-system-checks.js";

function commandResult(args: unknown, portOutput: string) {
  const argv = Array.isArray(args) ? args : [];
  return argv[0] === "inspect"
    ? { status: 0, stdout: "true\thealthy\timage", stderr: "" }
    : { status: 0, stdout: portOutput, stderr: "" };
}

describe("doctor system checks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(modulePath)];
  });

  it("validates Docker mappings against the sandbox gateway port exactly", () => {
    const hostCommand = requireDist("./doctor-host-command.js");
    const captureSpy = vi
      .spyOn(hostCommand, "captureHostCommand")
      .mockImplementation((_command: unknown, args: unknown) =>
        commandResult(args, "0.0.0.0:19080"),
      );
    const { dockerInspectGateway } = requireDist(modulePath);

    expect(dockerInspectGateway("gateway", {}, 19080)[1]).toMatchObject({ status: "ok" });

    captureSpy.mockImplementation((_command: unknown, args: unknown) =>
      commandResult(args, "0.0.0.0:190800"),
    );
    expect(dockerInspectGateway("gateway", {}, 19080)[1]).toMatchObject({
      status: "warn",
      hint: "expected host port 19080 for this sandbox gateway",
    });
  });
});
