// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import "../live/dgx-express.test.ts";

const capturedDgx = vi.hoisted(() => ({ run: undefined as unknown }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: Object.assign(vi.fn(), {
    for: () => (_title: string, _options: object, run: unknown) => {
      capturedDgx.run = run;
    },
  }),
}));
vi.mock("../live/inference-routing-helpers.ts", () => ({
  requireLivePrerequisites: vi.fn(),
  cleanupSandbox: vi.fn(),
  expectOpenAiChatThroughSandbox: vi.fn(),
}));
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
import {
  assertLocalDockerEnvironment,
  classifyDockerContainerInspection,
  inspectSandboxIdentity,
  listedSandboxNames,
  vllmPublicationProbeUrls,
} from "./spark-express-vllm-safety.ts";

const result = (exitCode: number, stdout = "", stderr = "") => ({
  command: ["docker"],
  cwd: "/tmp",
  durationMs: 1,
  exitCode,
  stderr,
  stdout,
});

describe("DGX Spark Express vLLM qualification safety", () => {
  it("probes both allowed addresses and every unintended IPv4 and IPv6 address (#14083)", () => {
    const ipv4 = (address: string, internal = false) => ({
      address,
      internal,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    });
    const ipv6 = (address: string, scopeid = 0) => ({
      address,
      scopeid,
      internal: address === "::1",
      family: "IPv6" as const,
      netmask: "ffff:ffff:ffff:ffff::",
      mac: "",
      cidr: null,
    });
    expect(
      vllmPublicationProbeUrls("172.18.0.1", {
        lo: [ipv4("127.0.0.1", true), ipv6("::1")],
        openshell: [ipv4("172.18.0.1")],
        eth0: [ipv4("192.0.2.10"), ipv6("2001:db8::10"), ipv6("fe80::10", 2)],
      }),
    ).toEqual({
      allowed: ["http://127.0.0.1:8000/health", "http://172.18.0.1:8000/health"],
      denied: [
        "http://[::1]:8000/health",
        "http://192.0.2.10:8000/health",
        "http://[2001:db8::10]:8000/health",
        "http://[fe80::10%25eth0]:8000/health",
      ],
      ipv6: "configured",
    });
  });

  it("reports an IPv4-only host and rejects an empty denial sample", () => {
    const entry = {
      address: "192.0.2.10",
      internal: false,
      family: "IPv4" as const,
      netmask: "255.255.255.0",
      mac: "",
      cidr: null,
    };
    expect(vllmPublicationProbeUrls("172.18.0.1", { eth0: [entry] }).ipv6).toBe("unconfigured");
    expect(() => vllmPublicationProbeUrls("172.18.0.1", {})).toThrow("unintended non-loopback");
  });

  it("accepts only local Docker selectors (#8379)", () => {
    expect(() => assertLocalDockerEnvironment({})).not.toThrow();
    expect(() =>
      assertLocalDockerEnvironment({ DOCKER_HOST: "unix:///var/run/docker.sock" }),
    ).not.toThrow();
    expect(() => assertLocalDockerEnvironment({ DOCKER_HOST: "ssh://spark.example" })).toThrow(
      "local Docker socket",
    );
    expect(() => assertLocalDockerEnvironment({ DOCKER_CONTEXT: "remote-spark" })).toThrow(
      "default local Docker context",
    );
  });

  it("distinguishes an absent container from Docker daemon failures (#8379)", () => {
    expect(classifyDockerContainerInspection(result(0, "[]"))).toBe("present");
    expect(
      classifyDockerContainerInspection(result(1, "", "Error: No such object: nemoclaw-vllm")),
    ).toBe("absent");
    expect(() =>
      classifyDockerContainerInspection(
        result(1, "", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"),
      ),
    ).toThrow("Docker container inspection failed");
  });

  it("refuses to treat a failed sandbox listing as an empty host (#8379)", () => {
    expect(listedSandboxNames(result(0, "alpha\nbeta\n"))).toEqual(new Set(["alpha", "beta"]));
    expect(() => listedSandboxNames(result(1, "", "gateway unavailable"))).toThrow(
      "OpenShell sandbox listing failed",
    );
  });

  it("requires an exact sandbox identity and distinguishes absence from inspection failure (#8379)", () => {
    const id = "05d120e4-484c-47d4-9a59-77a08cbb6e67";
    expect(
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "spark-e2e" })), "spark-e2e"),
    ).toEqual({ kind: "present", id });
    expect(inspectSandboxIdentity(result(1, "", "sandbox not found"), "spark-e2e")).toEqual({
      kind: "absent",
    });
    expect(() =>
      inspectSandboxIdentity(result(0, JSON.stringify({ id, name: "replacement" })), "spark-e2e"),
    ).toThrow("expected identity");
    expect(() => inspectSandboxIdentity(result(1, "", "gateway unavailable"), "spark-e2e")).toThrow(
      "sandbox inspection failed",
    );
    expect(() =>
      inspectSandboxIdentity(result(1, "", "gateway 'nemoclaw' not found"), "spark-e2e"),
    ).toThrow("sandbox inspection failed");
  });
});

describe.each(["fixed-profile", "extra-arguments"] as const)(
  "DGX Spark %s container cleanup",
  (variant) => {
    it.each([
      { state: "owned", failure: false, removalAttempted: true },
      { state: "absent", failure: false, removalAttempted: false },
      { state: "daemon", failure: true, removalAttempted: false },
      { state: "permission", failure: true, removalAttempted: false },
      { state: "replacement", failure: true, removalAttempted: false },
      { state: "unmanaged", failure: true, removalAttempted: false },
      { state: "label-failure", failure: true, removalAttempted: false },
      { state: "remove-failure", failure: true, removalAttempted: true },
    ])(
      "records $state without hiding inspection or removal failures",
      async ({ state, failure, removalAttempted }) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark-cleanup-"));
        directories.push(directory);
        const marker = path.join(directory, "removed");
        const id = "a".repeat(64);
        fs.writeFileSync(
          path.join(directory, "docker"),
          `#!/bin/bash
set -eu
case "$1" in
  inspect)
    case "$CLEANUP_STATE" in
      absent) echo 'Error: No such object: nemoclaw-vllm' >&2; exit 1 ;;
      daemon) echo 'Cannot connect to the Docker daemon' >&2; exit 1 ;;
      permission) echo 'permission denied connecting to Docker' >&2; exit 1 ;;
    esac
    if [[ "$3" == '{{.Id}}' ]]; then
      if [[ "$CLEANUP_STATE" == replacement ]]; then printf '%064d\n' 0; else echo "$CREATED_ID"; fi
    else
      [[ "$CLEANUP_STATE" != label-failure ]] || { echo 'Docker label inspection failed' >&2; exit 1; }
      if [[ "$CLEANUP_STATE" == unmanaged ]]; then echo false; else echo true; fi
    fi ;;
  rm)
    printf '%s\n' "$*" > "$REMOVE_MARKER"
    [[ "$CLEANUP_STATE" != remove-failure ]] || { echo 'Docker removal failed' >&2; exit 1; } ;;
  *) exit 99 ;;
esac
`,
          { mode: 0o700 },
        );
        vi.stubEnv("DOCKER_HOST", "");
        vi.stubEnv("DOCKER_CONTEXT", "");
        const cleanup = new CleanupRegistry();
        const responses = {
          "spark-express-platform": result(0, "DGX Spark"),
          "spark-express-nvidia-smi": result(0),
          "spark-extra-arguments-physical-memory": result(0, "63082733568"),
          "preflight-spark-express-vllm-container": result(1, "", "No such container"),
          "preflight-spark-express-sandbox-list": result(0),
          "spark-express-vllm-onboard": result(1, "", "interrupted onboarding"),
          "spark-express-vllm-container-inspect": result(0, JSON.stringify([{ Id: id }])),
          "spark-express-vllm-sandbox-inspect": result(1, "", "sandbox not found"),
          "failure-spark-express-vllm-container-logs": result(0),
          "failure-spark-express-sandbox-get": result(0),
        };
        const executeCleanup = (command: string, args: string[]) => {
          const child = spawnSync(command, args, {
            encoding: "utf8",
            timeout: 5_000,
            env: {
              PATH: `${directory}:${process.env.PATH}`,
              CLEANUP_STATE: state,
              CREATED_ID: id,
              REMOVE_MARKER: marker,
            },
          });
          return child.error
            ? Promise.reject(child.error)
            : result(child.status ?? 1, child.stdout, child.stderr);
        };
        const host = {
          command: vi.fn(
            async (command: string, args: string[], options: { artifactName: string }) =>
              options.artifactName.startsWith("cleanup-")
                ? executeCleanup(command, args)
                : (responses[options.artifactName as keyof typeof responses] ??
                  Promise.reject(new Error(`Unexpected command: ${options.artifactName}`))),
          ),
        };
        const run = capturedDgx.run as (
          selection: readonly string[],
          fixtures: object,
        ) => Promise<void>;
        await expect(
          run(
            [
              variant === "extra-arguments" ? "spark-vllm-extra-arguments" : "spark-express-vllm",
              variant,
            ],
            {
              artifacts: { target: { declare: vi.fn() } },
              cleanup,
              host,
              sandbox: {},
              runtimeProvider: {},
              progress: { phase: vi.fn() },
            },
          ),
        ).rejects.toThrow("interrupted onboarding");
        const receipt = await cleanup.runAll();
        expect(receipt.failures.map(({ name }) => name)).toEqual(
          failure ? ["remove nemoclaw-vllm"] : [],
        );
        expect(receipt.passed).toContain("remove sandbox e2e-spark-vllm");
        expect(receipt.passed.includes("remove nemoclaw-vllm")).toBe(!failure);
        expect(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null).toBe(
          removalAttempted ? `rm -f ${id}` : null,
        );
      },
    );
  },
);
