// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { preparePortableExperimentalHost } from "./portable-host-preparation";

describe("portable host architecture admission", () => {
  it("rejects arm64 before portable host effects (#11518)", () => {
    const systemctl = vi.fn();
    const podman = vi.fn();
    const docker = vi.fn();
    const validateConfigAuthority = vi.fn();
    const cpuDelegationPreflight = vi.fn(() => ({ ok: true as const, detail: "unused" }));
    const env: NodeJS.ProcessEnv = { NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" };

    expect(() =>
      preparePortableExperimentalHost(env, {
        platform: "linux",
        architecture: "arm64",
        systemctl,
        podman,
        docker,
        validateConfigAuthority,
        cpuDelegationPreflight,
      }),
    ).toThrow(
      "The portable experimental profile requires Linux x86_64 (amd64); detected Linux arm64.",
    );

    expect(env).toEqual({ NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" });
    expect(cpuDelegationPreflight).not.toHaveBeenCalled();
    expect(validateConfigAuthority).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
    expect(podman).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
  });
});
