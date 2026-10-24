// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ContainerEngine } from "../../../src/lib/adapters/container-engine.ts";

import {
  PODMAN_ISOLATION_ROLE_LABEL,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../../src/lib/onboard/runtime-provider/podman-lifecycle.ts";
import { sanitizePodmanInspectArtifact } from "../live/podman-cpu-lifecycle-artifacts.ts";
import { captureFailureContainerDiagnostics } from "../live/podman-cpu-lifecycle-helpers.ts";

const SECRET = "nvapi-this-must-not-reach-artifacts";

function inspectOutput(
  labelOverrides: Readonly<Record<string, string>> = {},
  status = "running",
  stateOverrides: Readonly<Record<string, unknown>> = {},
): string {
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
          [PODMAN_ISOLATION_ROLE_LABEL]: "sandbox",
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
        ExitCode: 0,
        OOMKilled: false,
        Error: SECRET,
        Paused: false,
        Running: true,
        Status: status,
        ...stateOverrides,
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
        [PODMAN_ISOLATION_ROLE_LABEL]: "sandbox",
        [PODMAN_SANDBOX_ID_LABEL]: "sandbox-id",
        [PODMAN_SANDBOX_NAME_LABEL]: "podman-openclaw",
        [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
        [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
        "nemoclaw.agent": "openclaw",
      },
      state: { exitCode: 0, oomKilled: false, paused: false, running: true, status: "running" },
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(summary).not.toHaveProperty("Id");
    expect(summary).not.toHaveProperty("Name");
    expect(summary).not.toHaveProperty("Config");
    expect(summary).not.toHaveProperty("LogPath");
  });

  it("distinguishes a failed supervisor from its workload without exposing runtime errors", () => {
    const summary = sanitizePodmanInspectArtifact(
      inspectOutput({ [PODMAN_ISOLATION_ROLE_LABEL]: "supervisor" }, "exited", {
        ExitCode: 137,
        OOMKilled: true,
        Running: false,
      }),
    );
    expect(summary.labels[PODMAN_ISOLATION_ROLE_LABEL]).toBe("supervisor");
    expect(summary.state).toEqual({
      exitCode: 137,
      oomKilled: true,
      paused: false,
      running: false,
      status: "exited",
    });
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it.each([undefined, null, SECRET, "137", -1, 256, 1.5])(
    "omits invalid diagnostic state values: %s",
    (value) => {
      const summary = sanitizePodmanInspectArtifact(
        inspectOutput({ [PODMAN_ISOLATION_ROLE_LABEL]: SECRET }, "exited", {
          ExitCode: value,
          OOMKilled: value,
        }),
      );
      expect(summary.labels[PODMAN_ISOLATION_ROLE_LABEL]).toBeNull();
      expect(summary.state.exitCode).toBeNull();
      expect(summary.state.oomKilled).toBeNull();
      expect(JSON.stringify(summary)).not.toContain(SECRET);
    },
  );

  it("omits a secret-shaped value even when it occupies an allowlisted label", () => {
    const summary = sanitizePodmanInspectArtifact(
      inspectOutput({ [PODMAN_SANDBOX_NAME_LABEL]: SECRET }),
    );

    expect(summary.labels[PODMAN_SANDBOX_NAME_LABEL]).toBeNull();
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("omits an unrecognized secret-shaped container status", () => {
    const summary = sanitizePodmanInspectArtifact(inspectOutput({}, "token-secret_value"));

    expect(summary.state.status).toBeNull();
    expect(JSON.stringify(summary)).not.toContain("token-secret_value");
  });

  it("keeps live cleanup diagnostics on the same sanitized filesystem boundary", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "podman-proof-artifacts-"));
    const containerId = "a".repeat(64);
    const responses = [
      { status: 0, stdout: `${containerId}\n`, stderr: "" },
      { status: 0, stdout: inspectOutput(), stderr: "" },
    ];
    let responseIndex = 0;
    const engine: ContainerEngine = {
      operation: "sandbox-lifecycle",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "test-podman-authority",
      capture: () => responses[responseIndex++]!,
      captureHost: () => {
        throw new Error("captureHost is not used by failure diagnostics");
      },
    };

    try {
      captureFailureContainerDiagnostics(engine, ["podman-openclaw"], artifactDir);

      const diagnosticDir = path.join(artifactDir, "failure-containers");
      expect(fs.readdirSync(diagnosticDir)).toEqual(["managed-container-summary.json"]);
      const artifact = fs.readFileSync(
        path.join(diagnosticDir, "managed-container-summary.json"),
        "utf8",
      );
      expect(JSON.parse(artifact)).toEqual({
        schemaVersion: 1,
        containers: [sanitizePodmanInspectArtifact(inspectOutput())],
      });
      expect(artifact).not.toContain(SECRET);
    } finally {
      fs.rmSync(artifactDir, { force: true, recursive: true });
    }
  });
});
