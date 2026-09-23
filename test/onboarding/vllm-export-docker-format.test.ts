// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerClientAvailable, startVllmExportFormatFixture } from "./vllm-export-format-fixture";

type Fixture = Awaited<ReturnType<typeof startVllmExportFormatFixture>>;

describe.skipIf(!dockerClientAvailable)("managed vLLM Docker format boundary", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await startVllmExportFormatFixture();
  });
  afterEach(async () => {
    await fixture?.close();
  });

  it("renders the fixed runtime through the actual Docker client", () => {
    expect(fixture.run().serving.hostPort).toBe(18000);
    expect(JSON.stringify(fixture.calls)).not.toContain(fixture.key);
  });

  it("accepts reordered equivalent resource limits", () => {
    fixture.objects.container.HostConfig.Ulimits.reverse();
    expect(fixture.run().serving.hostPort).toBe(18000);
  });

  it("accepts Docker null defaults for unused runtime settings", () => {
    Object.assign(fixture.objects.container.HostConfig, {
      Devices: null,
      CapAdd: null,
      SecurityOpt: null,
      Tmpfs: null,
    });
    Object.assign(fixture.objects.container.HostConfig.DeviceRequests[0]!, { DeviceIDs: null });
    expect(fixture.run().serving.hostPort).toBe(18000);
  });

  it.each([
    [
      "additional capability",
      (f: Fixture) => Object.assign(f.objects.container.HostConfig, { CapAdd: ["SYS_ADMIN"] }),
    ],
    [
      "malformed optional settings",
      (f: Fixture) => Object.assign(f.objects.container.HostConfig, { CapAdd: false }),
    ],
    ["command", (f: Fixture) => f.objects.container.Config.Cmd.push("--unrepresented")],
    [
      "environment injection",
      (f: Fixture) => f.objects.container.Config.Env.push('INJECTION={{printf "unsafe"}}'),
    ],
    [
      "entrypoint",
      (f: Fixture) => {
        f.objects.container.Config.Entrypoint = ["/bin/sh"];
      },
    ],
    [
      "stopped container",
      (f: Fixture) => {
        f.objects.container.State.Running = false;
      },
    ],
    [
      "GPU request",
      (f: Fixture) => {
        f.objects.container.HostConfig.DeviceRequests = [];
      },
    ],
    [
      "resource limit",
      (f: Fixture) => {
        f.objects.container.HostConfig.Ulimits[0]!.Soft = 1;
      },
    ],
    [
      "writable mount",
      (f: Fixture) => {
        f.objects.container.Mounts[0]!.RW = true;
      },
    ],
    [
      "shared memory",
      (f: Fixture) => {
        f.objects.container.HostConfig.ShmSize = 1;
      },
    ],
  ])("rejects changed %s at the Docker format boundary", (_name, change) => {
    change(fixture);
    expect(fixture.run).toThrow("The fixed managed vLLM runtime could not be verified for export.");
  });

  it("keeps quoted image defaults literal and private authentication out of observations", () => {
    const literal = 'LITERAL={{printf "unsafe"}}';
    fixture.objects.image.Config.Env.push(literal);
    fixture.objects.container.Config.Env.push(literal);
    const observation = JSON.stringify(fixture.run());
    expect(observation).not.toContain(fixture.key);
    expect(observation).not.toContain(fixture.fingerprint);
    expect(observation).not.toContain(fixture.directory);
    expect(observation).not.toContain(literal);
    expect(observation).not.toContain("VLLM_API_KEY");
    expect(JSON.stringify(fixture.calls)).not.toContain(fixture.key);
  });
});
