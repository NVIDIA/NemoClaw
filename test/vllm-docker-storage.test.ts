// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect } from "vitest";

import { HOST_LOCAL_VLLM_CONTAINER_NAME } from "../src/lib/inference/serving/vllm-host-local-lifecycle";
import { detectVllmProfile } from "../src/lib/inference/vllm";
import { imageStorageRequirementBytes } from "../src/lib/inference/vllm-storage";
import { test } from "./e2e/fixtures/workflow-e2e-test.ts";

const TARGET_ID = "vllm-docker-storage";
const DOCKER_HOST = "unix:///run/docker.sock";
const INSTALL_SUBPROCESS_TIMEOUT_MS = 15_000;
const VLLM_STORAGE_PHASES = [
  "inspect Docker storage prerequisites",
  "exercise the managed vLLM storage gate",
  "verify Docker and filesystem capacity evidence",
  "record release-candidate storage evidence",
  "release vLLM storage fixtures",
] as const;
const RUN_REAL_DOCKER =
  process.env.E2E_TARGET_ID === TARGET_ID ||
  process.env.NEMOCLAW_RUN_VLLM_STORAGE_DOCKER_E2E === "1";
const realDockerTest = RUN_REAL_DOCKER ? test : test.skip;

interface DockerInfo {
  DockerRootDir?: unknown;
  OSType?: unknown;
  ServerVersion?: unknown;
}

interface StatfsSample {
  path: string;
  bavail: string;
  bsize: string;
}

function dockerProxySource(realDockerPath: string, commandLogPath: string): string {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLogPath)}, JSON.stringify(args) + "\\n");
const command = ["container", "image"].includes(args[0])
  ? args.slice(0, 2).join(" ")
  : args[0];
const allowed = new Set(["container inspect", "container ls", "image inspect", "info"]);
const expectedContainerInspection =
  command !== "container inspect" ||
  (args.length === 3 && args[2] === ${JSON.stringify(HOST_LOCAL_VLLM_CONTAINER_NAME)});
if (!allowed.has(command) || !expectedContainerInspection) {
  process.stderr.write("blocked mutating Docker command: " + args.join(" ") + "\\n");
  process.exit(97);
}
const result = spawnSync(${JSON.stringify(realDockerPath)}, args, {
  env: process.env,
  stdio: "inherit",
  timeout: 10000,
  killSignal: "SIGKILL",
});
if (result.error) {
  process.stderr.write(result.error.message + "\\n");
  process.exit(98);
}
process.exit(result.status ?? 99);
`;
}

function installChildSource(vllmModuleUrl: string, statfsLogPath: string, model: string): string {
  return `
const fs = (await import("node:fs")).default;
const originalStatfsSync = fs.statfsSync.bind(fs);
fs.statfsSync = (...args) => {
  const sample = originalStatfsSync(...args);
  fs.appendFileSync(${JSON.stringify(statfsLogPath)}, JSON.stringify({
    path: String(args[0]),
    bavail: String(sample.bavail),
    bsize: String(sample.bsize),
  }) + "\\n");
  return sample;
};
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_PROVIDER = "install-vllm";
process.env.NEMOCLAW_VLLM_MODEL = ${JSON.stringify(model)};
delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
const vllmModule = await import(${JSON.stringify(vllmModuleUrl)});
const { detectVllmProfile, installVllm } = vllmModule.default ?? vllmModule;
const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
if (!profile) throw new Error("managed vLLM has no generic Linux profile");
const capabilities = [
  "host.platform.supported",
  "host.docker.available",
  "host.docker.daemon_reachable",
  "host.docker.runtime_supported",
  "host.docker.storage_compatible",
  "host.gpu.nvidia_available",
  "host.gpu.container_toolkit_available",
  "host.gpu.cdi_healthy",
].map((id) => ({ id, state: "present" }));
const report = {
  schemaVersion: "1.1.0",
  status: "supported",
  exitCode: 0,
  mutated: false,
  provenance: {
    nemoclawVersion: "0.0.0-test",
    sourceRevision: "${"a".repeat(40)}",
    observedAt: new Date().toISOString(),
  },
  observations: [
    { id: "host.os.platform", state: "present", value: "linux" },
    { id: "host.os.architecture", state: "present", value: process.arch },
    { id: "host.docker.runtime", state: "present", value: "docker" },
    { id: "host.gpu.count", state: "present", value: 1 },
    { id: "host.gpu.driver_version", state: "present", value: "580.65.06" },
    { id: "host.gpu.memory_total_bytes", state: "present", value: 34359738368 },
    { id: "host.gpu.memory_available_bytes", state: "present", value: 34359738368 },
    { id: "host.gpu.memory_per_device_bytes", state: "present", value: 34359738368 },
    { id: "host.gpu.unified_memory", state: "absent", value: false },
    { id: "host.gpu.compute_constrained", state: "absent", value: false },
  ],
  capabilities,
  qualifications: [],
  findings: [],
  evidence: [],
};
const result = await installVllm(profile, {
  hasImage: false,
  nonInteractive: true,
  promptFn: async () => "",
  readinessReports: [{ nodeId: "storage-proof", report }],
});
process.exitCode = result.ok ? 0 : 1;
`;
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST };
  delete env.DOCKER_CONTEXT;
  return env;
}

function writeEvidence(evidence: Record<string, unknown>): void {
  const artifactDir = process.env.E2E_ARTIFACT_DIR;
  const persist =
    artifactDir === undefined
      ? () => undefined
      : () => {
          fs.mkdirSync(artifactDir, { recursive: true });
          fs.writeFileSync(
            path.join(artifactDir, `${TARGET_ID}.json`),
            `${JSON.stringify(evidence, null, 2)}\n`,
          );
        };
  persist();
}

realDockerTest(
  "allows non-interactive express managed vLLM past the real /run/docker.sock storage gate (#7039)",
  { timeout: 30_000, meta: { e2ePhases: VLLM_STORAGE_PHASES } },
  ({ progress }) => {
    expect(process.platform, "this release acceptance requires a native Linux host").toBe("linux");
    expect(
      fs.statSync("/run/docker.sock").isSocket(),
      "/run/docker.sock must be a Unix socket",
    ).toBe(true);

    const env = dockerEnvironment();
    const infoResult = spawnSync("docker", ["info", "--format", "{{json .}}"], {
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      timeout: 15_000,
    });
    expect(
      infoResult.status,
      `docker info through ${DOCKER_HOST} failed:\n${
        infoResult.error?.message || infoResult.stderr || infoResult.stdout
      }`,
    ).toBe(0);

    const info = JSON.parse(infoResult.stdout) as DockerInfo;
    expect(info.OSType).toBe("linux");
    expect(typeof info.DockerRootDir).toBe("string");
    const dockerRootDir = String(info.DockerRootDir);
    expect(path.isAbsolute(dockerRootDir)).toBe(true);

    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    assert(profile, "managed vLLM has no generic Linux profile");
    const requiredAvailableBytes = imageStorageRequirementBytes(profile.imageDownloadSizeBytes);

    progress.phase("exercise the managed vLLM storage gate");
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-storage-"));
    const blockedHome = path.join(fakeBinDir, "blocked-home");
    const commandLogPath = path.join(fakeBinDir, "docker-commands.jsonl");
    const statfsLogPath = path.join(fakeBinDir, "statfs-samples.jsonl");
    const dockerPathResult = spawnSync("sh", ["-c", "command -v docker"], {
      encoding: "utf8",
      env,
      killSignal: "SIGKILL",
      timeout: 5_000,
    });
    expect(
      dockerPathResult.status,
      `could not resolve the Docker CLI: ${
        dockerPathResult.error?.message || dockerPathResult.stderr || dockerPathResult.stdout
      }`,
    ).toBe(0);
    const realDockerPath = dockerPathResult.stdout.trim();
    expect(path.isAbsolute(realDockerPath)).toBe(true);
    const cachedImageResult = spawnSync(
      realDockerPath,
      ["image", "inspect", "--format", "{{.Id}}", profile.image],
      { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 10_000 },
    );
    expect(
      cachedImageResult.error,
      `could not check the managed vLLM image cache: ${cachedImageResult.error?.message}`,
    ).toBeUndefined();
    expect(
      cachedImageResult.status,
      "the managed vLLM image must be absent so production cannot skip its storage guard",
    ).not.toBe(0);
    let installDockerCommands: string[] = [];
    let productionStatfsSamples: StatfsSample[] = [];
    let measuredPath = "";
    let measuredAvailableBytes = 0n;
    try {
      fs.mkdirSync(blockedHome);
      fs.writeFileSync(path.join(blockedHome, ".cache"), "not a directory\n");
      fs.writeFileSync(statfsLogPath, "");
      fs.writeFileSync(
        path.join(fakeBinDir, "nvidia-smi"),
        `#!/bin/sh
case "$#:$1:$2" in
  2:--query-gpu=compute_cap:--format=csv,noheader,nounits) printf '9.0\\n' ;;
  2:--query-gpu=index,uuid,memory.total,memory.free:--format=csv,noheader,nounits)
    printf '0, GPU-storage-proof, 131072, 131072\\n'
    ;;
  *) exit 64 ;;
esac
`,
        { mode: 0o755 },
      );
      fs.writeFileSync(path.join(fakeBinDir, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(fakeBinDir, "docker"),
        dockerProxySource(realDockerPath, commandLogPath),
        { mode: 0o755 },
      );
      const childEnv = dockerEnvironment();
      childEnv.HOME = blockedHome;
      childEnv.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
      const installResult = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          installChildSource(
            pathToFileURL(path.resolve("src/lib/inference/vllm.ts")).href,
            statfsLogPath,
            profile.defaultModel.envValue,
          ),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: childEnv,
          timeout: INSTALL_SUBPROCESS_TIMEOUT_MS,
          killSignal: "SIGKILL",
        },
      );
      expect(
        installResult.error,
        `managed-vLLM install subprocess failed to complete: ${installResult.error?.message}`,
      ).toBeUndefined();
      expect(
        installResult.status,
        `managed-vLLM express subprocess did not reach the intentional post-guard abort:\n${installResult.stderr}\n${installResult.stdout}`,
      ).toBe(1);
      expect(installResult.stderr).toContain("could not create Hugging Face cache directory");
      expect(installResult.stderr).not.toContain("Readiness requirement");
      expect(installResult.stderr).not.toContain("Docker storage for the managed vLLM image");
      expect(`${installResult.stdout}\n${installResult.stderr}`).not.toContain("Continue anyway");
      const dockerCommands = fs
        .readFileSync(commandLogPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as string[]);
      installDockerCommands = dockerCommands.map((args) => args.slice(0, 2).join(" "));
      expect(new Set(installDockerCommands)).toEqual(
        new Set(["container ls", "image inspect", "info --format"]),
      );
      const rejectedInspection = spawnSync(
        path.join(fakeBinDir, "docker"),
        ["container", "inspect", `${HOST_LOCAL_VLLM_CONTAINER_NAME}-other`],
        { encoding: "utf8", env: childEnv, killSignal: "SIGKILL", timeout: 5_000 },
      );
      expect(rejectedInspection.error).toBeUndefined();
      expect(rejectedInspection.status).toBe(97);
      expect(rejectedInspection.stderr).toContain("blocked mutating Docker command");

      progress.phase("verify Docker and filesystem capacity evidence");
      const statfsLog = fs.readFileSync(statfsLogPath, "utf8").trim();
      expect(statfsLog, "production did not consume a filesystem capacity sample").not.toBe("");
      productionStatfsSamples = statfsLog
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as StatfsSample);
      const dockerRootSample = [...productionStatfsSamples]
        .reverse()
        .find((sample) => path.resolve(sample.path) === path.resolve(dockerRootDir));
      assert(dockerRootSample, `production did not sample Docker root ${dockerRootDir}`);
      measuredPath = dockerRootSample.path;
      measuredAvailableBytes = BigInt(dockerRootSample.bavail) * BigInt(dockerRootSample.bsize);
      expect(measuredAvailableBytes).toBeGreaterThan(0n);
      expect(measuredAvailableBytes).toBeGreaterThanOrEqual(requiredAvailableBytes);

      progress.phase("record release-candidate storage evidence");
      const checkoutResult = spawnSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 5_000,
      });
      expect(
        checkoutResult.status,
        `could not record the validated checkout: ${
          checkoutResult.error?.message || checkoutResult.stderr || checkoutResult.stdout
        }`,
      ).toBe(0);
      const checkoutSha = checkoutResult.stdout.trim();
      expect(checkoutSha).toMatch(/^[0-9a-f]{40}$/u);
      const sourceVersionResult = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 5_000,
      });
      expect(
        sourceVersionResult.status,
        `could not record the validated source version: ${
          sourceVersionResult.error?.message ||
          sourceVersionResult.stderr ||
          sourceVersionResult.stdout
        }`,
      ).toBe(0);
      const releaseCandidateSourceVersion = sourceVersionResult.stdout.trim();
      expect(releaseCandidateSourceVersion).not.toBe("");
      const packageMetadata = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
      ) as { version?: unknown };
      expect(typeof packageMetadata.version).toBe("string");
      const packageVersion = String(packageMetadata.version);
      const evidence = {
        schemaVersion: 1,
        checkoutSha,
        releaseCandidateSourceVersion,
        packageVersion,
        platform: process.platform,
        architecture: process.arch,
        dockerHost: DOCKER_HOST,
        dockerServerVersion: info.ServerVersion,
        dockerRootDir,
        dockerRootAvailableBytes: String(measuredAvailableBytes),
        measuredPath,
        measuredSource: "Docker root directory",
        measuredAvailableBytes: String(measuredAvailableBytes),
        productionStatfsSamples,
        imageDownloadSizeBytes: String(profile.imageDownloadSizeBytes),
        requiredAvailableBytes: String(requiredAvailableBytes),
        managedInstallCrossedImageStorageGate: true,
        installSubprocessTimeoutMs: INSTALL_SUBPROCESS_TIMEOUT_MS,
        installDockerCommands,
      };
      writeEvidence(evidence);
      console.info(`[${TARGET_ID}] ${JSON.stringify(evidence)}`);
    } finally {
      progress.phase("release vLLM storage fixtures");
      fs.rmSync(fakeBinDir, { force: true, recursive: true });
    }
  },
);
