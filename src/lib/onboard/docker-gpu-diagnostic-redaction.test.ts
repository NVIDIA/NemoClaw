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
    const inspect: DockerContainerInspect = {
      Id: "new-container-id",
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
        "ps -a --filter label=openshell.ai/managed-by=openshell --filter label=openshell.ai/sandbox-name=alpha --format {{.ID}}",
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
            },
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

      expect(contents["summary.txt"]).toContain("failure_kind=patched_container_failed");
      expect(contents["summary.txt"]).toContain("useful failure context <REDACTED>");
      expect(contents["docker-logs.txt"]).toContain(
        "useful docker log context <REDACTED> <REDACTED>",
      );
      expect(contents["openshell-sandbox-get.txt"]).toContain("useful get context <REDACTED>");
      expect(contents["docker-network-summary.txt"]).toContain("network_mode=openshell-docker");
      const state = JSON.parse(contents["patched-container-state.json"]);
      expect(state.Error).toBe("useful state context <REDACTED>");
      const inspected = JSON.parse(contents["docker-inspect.json"]);
      expect(inspected[0].Config.Env).toEqual([
        "OPENSHELL_SANDBOX_COMMAND=<REDACTED>",
        "SIGNING_KEY=<REDACTED>",
      ]);
      expect(inspected[0].Config.Labels).toEqual({ "openshell.ai/sandbox-name": "alpha" });
      expect(inspected[0].Config.Cmd).toEqual(["hidden", "<1 additional arguments omitted>"]);

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
});
