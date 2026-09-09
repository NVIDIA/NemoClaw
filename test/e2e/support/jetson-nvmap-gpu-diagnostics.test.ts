// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerRun } from "../../../src/lib/adapters/docker/command.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  captureJetsonInstallFailureDiagnostics,
  installJetsonWithDiagnostics,
} from "../fixtures/jetson-diagnostics.ts";

vi.mock("../../../src/lib/adapters/docker/command.ts", () => ({ dockerRun: vi.fn() }));

const CONTAINER_ID = "a".repeat(64);
const OPAQUE_SECRET = "x".repeat(32);
const directories: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jetson-diagnostics-"));
  directories.push(root);
  const gatewayDirectory = path.join(root, ".local/state/nemoclaw/openshell-docker-gateway");
  fs.mkdirSync(gatewayDirectory, { recursive: true });
  const artifacts = new ArtifactSink(path.join(root, "artifacts"));
  const gatewayLog = path.join(gatewayDirectory, "openshell-gateway.log");
  const host = {
    openshellCommandPath: "/job/bin/openshell",
    command: vi.fn(
      async () => ({ exitCode: 0, stdout: "phase: Error", stderr: "" }) as ShellProbeResult,
    ),
  };
  const state = {
    Status: "exited",
    Running: false,
    ExitCode: 1,
    OOMKilled: false,
    Health: { Status: "unhealthy", Log: [{ Output: `startup failed ${OPAQUE_SECRET}` }] },
  };
  const output = (stdout: string, status = 0) => ({
    stdout,
    stderr: "",
    status,
    signal: null,
    pid: 1,
    output: [],
  });
  vi.mocked(dockerRun)
    .mockReturnValue(output("", 1))
    .mockReturnValueOnce(output(`${CONTAINER_ID}\n`))
    .mockReturnValueOnce(output(JSON.stringify(state)))
    .mockReturnValueOnce(
      output(
        JSON.stringify([{ State: state, Config: { Env: [`CUSTOM_TOKEN=${OPAQUE_SECRET}`] } }]),
      ),
    )
    .mockReturnValueOnce(output(`Cannot find module /fixture/startup.ts\n${OPAQUE_SECRET}`));
  const readEvidence = () =>
    JSON.parse(fs.readFileSync(artifacts.pathFor("jetson-install-failure.json"), "utf8"));
  return { root, artifacts, gatewayLog, host, readEvidence, output };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Jetson installation failure evidence", () => {
  it("retains container state and gateway errors while redacting runtime credentials", async () => {
    const f = fixture();
    fs.writeFileSync(f.gatewayLog, `supervisor exited: ${OPAQUE_SECRET}\n`);

    await captureJetsonInstallFailureDiagnostics(f.artifacts, f.host, "jetson-test", {
      HOME: f.root,
    });

    const evidence = f.readEvidence();
    expect(evidence.containers).toEqual([
      expect.objectContaining({
        id: CONTAINER_ID,
        state: expect.objectContaining({
          Status: "exited",
          ExitCode: 1,
          Health: expect.objectContaining({ Status: "unhealthy" }),
        }),
        redactedLogTail: expect.stringContaining("Cannot find module"),
      }),
    ]);
    expect(evidence.sandbox).toMatchObject({ stdout: "phase: Error" });
    expect(evidence.gatewayLogTail).toContain("supervisor exited");
    expect(JSON.stringify(evidence)).not.toContain(OPAQUE_SECRET);
    expect(f.host.command).toHaveBeenCalledWith(
      "/job/bin/openshell",
      ["sandbox", "get", "-g", "nemoclaw", "jetson-test"],
      expect.objectContaining({ persistArtifacts: false }),
    );
    expect(
      vi
        .mocked(dockerRun)
        .mock.calls.every(
          ([, options]) =>
            options?.timeout === 2_000 &&
            options.maxBuffer === 256 * 1024 &&
            options.suppressOutput === true,
        ),
    ).toBe(true);
  });

  it("bounds container selection and gateway logs before cleanup", async () => {
    const f = fixture();
    const ids = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
    vi.mocked(dockerRun)
      .mockReset()
      .mockReturnValue(f.output("unavailable", 1))
      .mockReturnValueOnce(f.output([...ids, ids[0], "invalid;command"].join("\n")));
    fs.writeFileSync(f.gatewayLog, `old evidence\n${"x".repeat(20_000)}\nlast failure\n`);

    await captureJetsonInstallFailureDiagnostics(f.artifacts, f.host, "jetson-test", {
      HOME: f.root,
    });

    expect(f.readEvidence()).toMatchObject({
      containersTruncated: true,
      containers: ids.slice(0, 4).map((id) => ({ id, state: null, redactedLogTail: "" })),
      gatewayLogTail: "last failure\n",
    });
    expect(vi.mocked(dockerRun).mock.calls.some(([args]) => args.includes(ids[4]!))).toBe(false);
    expect(vi.mocked(dockerRun).mock.calls[0]?.[0]).toContain(
      "label=openshell.ai/sandbox-name=jetson-test",
    );
  });

  it("retains gateway evidence when Docker and OpenShell probes fail", async () => {
    const f = fixture();
    vi.mocked(dockerRun)
      .mockReset()
      .mockImplementation(() => {
        throw new Error("Docker unavailable");
      });
    f.host.command.mockRejectedValue(new Error("OpenShell unavailable"));
    fs.writeFileSync(f.gatewayLog, "gateway lost supervisor\n");

    await captureJetsonInstallFailureDiagnostics(f.artifacts, f.host, "jetson-test", {
      HOME: f.root,
    });

    expect(f.readEvidence()).toMatchObject({
      inventoryAvailable: false,
      containers: [],
      sandbox: null,
      gatewayLogTail: "gateway lost supervisor\n",
    });
  });

  it("rejects a gateway log symlink and preserves installation failure when artifact writing fails", async () => {
    const f = fixture();
    const privateFile = path.join(f.root, "private-file");
    fs.writeFileSync(privateFile, "private contents");
    fs.symlinkSync(privateFile, f.gatewayLog);
    await captureJetsonInstallFailureDiagnostics(f.artifacts, f.host, "jetson-test", {
      HOME: f.root,
    });
    expect(f.readEvidence().gatewayLogTail).toBeNull();

    vi.spyOn(f.artifacts, "writeJson").mockRejectedValue(new Error("disk unavailable"));
    const primaryFailure = new Error("installation failed");
    f.host.command.mockRejectedValueOnce(primaryFailure);
    await expect(
      installJetsonWithDiagnostics(f.artifacts, f.host, "jetson-test", { HOME: f.root }, f.root),
    ).rejects.toBe(primaryFailure);
  });

  it.each([0, 1, null])(
    "returns installation exit code %s after any required diagnostics finish",
    async (exitCode) => {
      const f = fixture();
      const installed = { exitCode, timedOut: exitCode === null } as ShellProbeResult;
      f.host.command.mockResolvedValueOnce(installed);

      const result = await installJetsonWithDiagnostics(
        f.artifacts,
        f.host,
        "jetson-test",
        { HOME: f.root },
        f.root,
      );

      expect(result).toBe(installed);
      expect(fs.existsSync(f.artifacts.pathFor("jetson-install-failure.json"))).toBe(
        exitCode !== 0,
      );
      expect(f.host.command).toHaveBeenCalledTimes(exitCode === 0 ? 1 : 2);
    },
  );
});
