// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../../src/lib/onboard/runtime-provider/podman-lifecycle.ts";
import { readRepoText } from "../../helpers/e2e-workflow-contract";
import { sanitizePodmanInspectArtifact } from "../live/podman-cpu-lifecycle-artifacts.ts";

const SECRET = "nvapi-this-must-not-reach-artifacts";

function inspectOutput(labelOverrides: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify([
    {
      Id: SECRET,
      Name: SECRET,
      LogPath: `/tmp/${SECRET}.log`,
      Config: {
        Cmd: ["/bin/sh", "-lc", `printf ${SECRET}`],
        Entrypoint: ["/entrypoint", SECRET],
        Env: [`NVIDIA_API_KEY=${SECRET}`],
        Labels: {
          [PODMAN_MANAGED_LABEL]: "true",
          [PODMAN_SANDBOX_ID_LABEL]: "sandbox-id",
          [PODMAN_SANDBOX_NAME_LABEL]: "podman-openclaw",
          [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
          [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
          "nemoclaw.agent": "openclaw",
          "unreviewed.secret": SECRET,
          ...labelOverrides,
        },
      },
      State: {
        Error: SECRET,
        Paused: false,
        Running: true,
        Status: "running",
      },
    },
  ]);
}

describe("Podman CPU proof artifact sanitization", () => {
  it("publishes only allowlisted ownership labels and container state", () => {
    const summary = sanitizePodmanInspectArtifact(inspectOutput());

    expect(summary).toEqual({
      labels: {
        [PODMAN_MANAGED_LABEL]: "true",
        [PODMAN_SANDBOX_ID_LABEL]: "sandbox-id",
        [PODMAN_SANDBOX_NAME_LABEL]: "podman-openclaw",
        [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
        [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
        "nemoclaw.agent": "openclaw",
      },
      state: { paused: false, running: true, status: "running" },
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary).not.toHaveProperty("Id");
    expect(summary).not.toHaveProperty("Name");
    expect(summary).not.toHaveProperty("Config");
    expect(summary).not.toHaveProperty("LogPath");
  });

  it("omits a secret-shaped value even when it occupies an allowlisted label", () => {
    const summary = sanitizePodmanInspectArtifact(
      inspectOutput({ [PODMAN_SANDBOX_NAME_LABEL]: SECRET }),
    );

    expect(summary.labels[PODMAN_SANDBOX_NAME_LABEL]).toBeNull();
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("keeps live cleanup diagnostics on the same sanitized summary boundary", () => {
    const helper = readRepoText("test/e2e/live/podman-cpu-lifecycle-helpers.ts");

    expect(helper).toContain("sanitizePodmanInspectArtifact(result.stdout)");
    expect(helper).toContain("managed-container-summary.json");
    expect(helper).not.toContain('["logs", containerId]');
    expect(helper).not.toContain('["inspect.json"');
  });
});
