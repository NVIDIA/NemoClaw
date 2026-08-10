// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuMode,
  collectDockerGpuPatchDiagnostics,
  type DockerContainerInspect,
  type DockerContainerState,
  printDockerGpuPatchFailureAndExit,
} from "./docker-gpu-patch";

describe("Docker GPU diagnostic redaction", () => {
  it("redacts opaque conventional and custom-placeholder values from every shared collector sink", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-diagnostic-redaction-"));
    const canaries = {
      error: "opaque-a-7f31",
      modeAttempt: "opaque-b-8a42",
      headline: "opaque-c-9b53",
      sandboxList: "opaque-d-ac64",
      containerState: "opaque-e-bd75",
      dockerPs: "opaque-f-ce86",
      inspect: "opaque-g-df97",
      network: "opaque-h-e0a8",
      dockerLogs: "opaque-i-f1b9",
      openshellGet: "opaque-j-02ca",
      openshellList: "opaque-k-13db",
      openshellLogs: "opaque-l-24ec",
    } as const;
    const placeholderEntries = Object.entries(canaries).map(
      ([key, value]) => [`COLLECTOR_${key.toUpperCase()}`, value] as const,
    );
    const placeholderKeys = placeholderEntries.map(([key]) => key).join(",");
    const startupCommand = [
      "env",
      `NEMOCLAW_EXTRA_PLACEHOLDER_KEYS=${placeholderKeys}`,
      ...placeholderEntries.map(([key, value]) => `${key}=${value}`),
      "nemoclaw-start",
    ].join(" ");
    const suffixCanary = ["redaction", "sentinel"].join("-");
    const unallowlistedStateCanary = "future-runtime-payload-8690";
    const inspect: DockerContainerInspect = {
      Id: "new-container-id",
      Image: `sha256:${"d".repeat(64)}`,
      Name: `/openshell-alpha-${canaries.inspect}`,
      Config: {
        Image: "openshell/sandbox:test",
        Env: [`OPENSHELL_SANDBOX_COMMAND=${startupCommand}`, `SIGNING_KEY=${suffixCanary}`],
        Labels: {
          "openshell.ai/sandbox-name": "alpha",
          "untrusted.label": canaries.inspect,
        },
        Entrypoint: ["/opt/openshell/bin/openshell-sandbox"],
        Cmd: ["hidden", canaries.inspect],
        User: "1000",
      },
      HostConfig: {
        NetworkMode: "openshell-docker",
        RestartPolicy: { Name: "unless-stopped" },
        GroupAdd: ["1000"],
      },
      State: {
        Status: "running",
        Running: true,
        ExitCode: 0,
        Health: {
          Status: "healthy",
          FailingStreak: 0,
          Log: [{ Output: unallowlistedStateCanary }],
        },
        FutureRuntimeField: unallowlistedStateCanary,
      } as DockerContainerInspect["State"],
      NetworkSettings: {
        Networks: {
          "openshell-docker": {
            IPAddress: "172.18.0.2",
            Gateway: "172.18.0.1",
            Aliases: [`alpha-${canaries.network}`],
          },
        },
      },
    };
    const dockerResponses = new Map([
      [
        "ps -a --no-trunc --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
        "new-container-id\n",
      ],
      ["inspect new-container-id", JSON.stringify([inspect])],
      [
        "ps -a --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha",
        `new-container-id running ${canaries.dockerPs}\n`,
      ],
    ]);
    const dockerCapture = vi.fn(
      (args: readonly string[]) => dockerResponses.get(args.join(" ")) ?? "",
    );
    const openshellResponses = new Map([
      ["sandbox get", `Phase: Error\nuseful get context ${canaries.openshellGet}\n`],
      ["sandbox list", `alpha Error useful list context ${canaries.openshellList}\n`],
      ["doctor logs", `useful gateway log context ${canaries.openshellLogs}\n`],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[]) => openshellResponses.get(`${args[0] ?? ""} ${args[1] ?? ""}`) ?? "",
    );
    const writeFileSpy = vi.spyOn(fs, "writeFileSync");

    try {
      const mode = buildDockerGpuMode("gpus");
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          error: new Error(`useful failure context ${canaries.error}`),
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: mode,
            modeAttempts: [
              { mode, ok: false, error: `useful mode context ${canaries.modeAttempt}` },
            ],
          },
          selectedMode: mode,
          snapshot: {
            sandboxPhase: "Error",
            sandboxListLine: `alpha Error useful snapshot context ${canaries.sandboxList}`,
            patchedContainerState: {
              Status: "exited",
              ExitCode: 125,
              Error: `useful state context ${canaries.containerState}`,
              FutureRuntimeField: unallowlistedStateCanary,
              Health: {
                Status: "unhealthy",
                FailingStreak: 2,
                Log: [{ Output: unallowlistedStateCanary }],
              },
            } as DockerContainerState,
          },
          classification: {
            kind: "patched_container_failed",
            headline: `useful headline context ${canaries.headline}`,
            summaryLines: [],
          },
        },
        {
          dockerCapture,
          dockerLogs: vi.fn(
            () => `useful docker log context ${canaries.dockerLogs} ${suffixCanary}\n`,
          ),
          homedir: () => tmpDir,
          now: () => new Date("2026-07-02T00:00:00Z"),
          runCaptureOpenshell,
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      const expectedFiles = [
        "summary.txt",
        "patched-container-state.json",
        "docker-ps.txt",
        "docker-inspect.json",
        "docker-network-summary.txt",
        "docker-logs.txt",
        "openshell-sandbox-get.txt",
        "openshell-sandbox-list.txt",
        "openshell-logs.txt",
      ];
      const contents = Object.fromEntries(
        expectedFiles.map((name) => [
          name,
          fs.readFileSync(path.join(diagnostics?.dir ?? "", name), "utf8"),
        ]),
      );
      const published = `${diagnostics?.summaryLines.join("\n")}\n${Object.values(contents).join("\n")}`;
      for (const canary of Object.values(canaries)) expect(published).not.toContain(canary);
      expect(published).not.toContain(suffixCanary);
      expect(published).not.toContain(unallowlistedStateCanary);

      expect(contents["summary.txt"]).toContain("failure_kind=patched_container_failed");
      expect(contents["summary.txt"]).toContain("useful failure context <REDACTED>");
      expect(contents["docker-logs.txt"]).toContain(
        "useful docker log context <REDACTED> <REDACTED>",
      );
      expect(contents["openshell-sandbox-get.txt"]).toContain("useful get context <REDACTED>");
      expect(contents["docker-network-summary.txt"]).toContain("network_mode=openshell-docker");
      expect(contents["docker-network-summary.txt"]).toContain(`image_id=sha256:${"d".repeat(64)}`);
      const state = JSON.parse(contents["patched-container-state.json"]);
      expect(state.Error).toBe("useful state context <REDACTED>");
      expect(state).toEqual({
        Status: "exited",
        ExitCode: 125,
        Error: "useful state context <REDACTED>",
        Health: { Status: "unhealthy", FailingStreak: 2 },
      });
      const inspected = JSON.parse(contents["docker-inspect.json"]);
      expect(inspected[0].Config.Env).toEqual([
        "OPENSHELL_SANDBOX_COMMAND=<REDACTED>",
        "SIGNING_KEY=<REDACTED>",
      ]);
      expect(inspected[0].Config.Labels).toEqual({ "openshell.ai/sandbox-name": "alpha" });
      expect(inspected[0].Config.Cmd).toEqual(["hidden", "<1 additional arguments omitted>"]);
      expect(inspected[0].Image).toBe(`sha256:${"d".repeat(64)}`);
      expect(inspected[0].State).toEqual({
        Status: "running",
        Running: true,
        ExitCode: 0,
        Health: { Status: "healthy", FailingStreak: 0 },
      });

      const fullInspectOrders = dockerCapture.mock.calls
        .map(([args], index) => ({ args, order: dockerCapture.mock.invocationCallOrder[index] }))
        .filter(({ args }) => args[0] === "inspect" && args[1] !== "--format")
        .map(({ order }) => order ?? 0);
      expect(fullInspectOrders.length).toBeGreaterThan(0);
      expect(Math.max(...fullInspectOrders)).toBeLessThan(
        writeFileSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
      );
    } finally {
      writeFileSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "exact", observed: ["a".repeat(64)], expected: "yes" },
    { label: "wrong", observed: ["b".repeat(64)], expected: "no" },
    { label: "missing", observed: [], expected: "missing" },
    {
      label: "ambiguous",
      observed: ["a".repeat(64), "b".repeat(64)],
      expected: "ambiguous",
    },
  ])("records $label replacement identity evidence (#8690)", ({ observed, expected }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-container-identity-"));
    const expectedId = "a".repeat(64);
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: expectedId,
          },
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "ps" && args.includes("--no-trunc") ? `${observed.join("\n")}\n` : "",
          ),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-07-02T00:10:00Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf8");
      expect(summary).toContain(`expected_container_id=${expectedId}`);
      expect(summary).toContain("container_identity_query=succeeded");
      expect(summary).toContain(`container_identity_match=${expected}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("records unknown identity when the Docker label query fails (#8690)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-container-query-failure-"));
    const expectedId = "a".repeat(64);
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: expectedId,
          },
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) => {
            if (args[0] === "ps" && args.includes("--no-trunc")) {
              throw new Error("Docker query timed out");
            }
            return "";
          }),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-07-02T00:11:00Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir ?? "", "summary.txt"), "utf8");
      expect(summary).toContain("observed_container_ids=unknown");
      expect(summary).toContain("container_identity_query=failed");
      expect(summary).toContain("container_identity_match=unknown");
      expect(summary).not.toContain("container_identity_match=missing");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps oversized lifecycle evidence bounded and valid JSON (#8690)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-json-"));
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          lifecycleObservations: Array.from({ length: 200 }, (_, attempt) => ({
            at: "2026-07-02T00:20:00Z",
            stage: "sandbox_readiness" as const,
            event: "phase_probe",
            attempt,
            output: "alpha Ready ".repeat(125),
          })),
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-07-02T00:20:00Z"),
        },
      );
      const lifecyclePath = path.join(diagnostics?.dir ?? "", "lifecycle-history.json");
      const published = fs.readFileSync(lifecyclePath, "utf8");

      expect(() => JSON.parse(published)).not.toThrow();
      expect(JSON.parse(published)).toMatchObject({ diagnosticTruncated: true });
      expect(fs.statSync(lifecyclePath).size).toBeLessThanOrEqual(256_000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("redacts proxy credentials from terminal recreation failures", () => {
    const rawProxy = "https://proxy-user-7a9c:proxy-secret-8b0d@proxy.example:8443";
    const output: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("diagnostics disabled for test");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__test_exit__");
    }) as never);

    try {
      expect(() =>
        printDockerGpuPatchFailureAndExit(
          "alpha",
          new Error(`Could not start recreated sandbox container: HTTPS_PROXY=${rawProxy}`),
          {
            runCaptureOpenshell: vi.fn(() => ""),
            dockerCapture: vi.fn(() => ""),
          },
        ),
      ).toThrow(/__test_exit__/);

      const stderr = output.join("\n");
      expect(stderr).toContain("https://****:****@proxy.example:8443/");
      expect(stderr).not.toContain(rawProxy);
      expect(stderr).not.toContain("proxy-user-7a9c");
      expect(stderr).not.toContain("proxy-secret-8b0d");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      mkdirSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
