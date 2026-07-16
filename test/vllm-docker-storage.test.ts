// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, test, vi } from "vitest";

import { detectVllmProfile } from "../src/lib/inference/vllm";
import {
  imageStorageRequirementBytes,
  probeDockerStorage,
} from "../src/lib/inference/vllm-storage";

const TARGET_ID = "vllm-docker-storage";
const DOCKER_HOST = "unix:///run/docker.sock";
const INSTALL_SUBPROCESS_TIMEOUT_MS = 15_000;
const RUN_REAL_DOCKER =
  process.env.E2E_TARGET_ID === TARGET_ID ||
  process.env.NEMOCLAW_RUN_VLLM_STORAGE_DOCKER_E2E === "1";
const realDockerTest = RUN_REAL_DOCKER ? test : test.skip;

interface DockerInfo {
  DockerRootDir?: unknown;
  OSType?: unknown;
  ServerVersion?: unknown;
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
const allowed = new Set(["container ls", "image inspect", "info"]);
if (!allowed.has(command)) {
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

function installChildSource(vllmModuleUrl: string): string {
  return `
import vllmModule from ${JSON.stringify(vllmModuleUrl)};
const { detectVllmProfile, installVllm } = vllmModule;
const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
if (!profile) throw new Error("managed vLLM has no generic Linux profile");
process.env.NEMOCLAW_VLLM_MODEL = profile.defaultModel.envValue;
delete process.env.NEMOCLAW_VLLM_EXTRA_ARGS_JSON;
const result = await installVllm({
  ...profile,
  image: "example.invalid/nemoclaw/vllm@sha256:${"0".repeat(64)}",
  containerName: "nemoclaw-vllm-storage-e2e-" + String(process.pid),
  pullTimeoutSec: 1,
}, {
  hasImage: false,
  nonInteractive: true,
  promptFn: async () => "",
});
process.stdout.write("\\nNEMOCLAW_INSTALL_RESULT=" + JSON.stringify(result) + "\\n");
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

realDockerTest(
  "allows non-interactive managed vLLM past the real /run/docker.sock storage gate (#7039)",
  () => {
    expect(process.platform, "this release acceptance requires a native Linux host").toBe("linux");
    expect(
      fs.statSync("/run/docker.sock").isSocket(),
      "/run/docker.sock must be a Unix socket",
    ).toBe(true);

    const env = dockerEnvironment();
    const infoResult = spawnSync("docker", ["info", "--format", "{{json .}}"], {
      encoding: "utf8",
      env,
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
    const dockerRootStats = fs.statfsSync(dockerRootDir, { bigint: true });
    const dockerRootAvailableBytes = dockerRootStats.bavail * dockerRootStats.bsize;
    expect(dockerRootAvailableBytes).toBeGreaterThan(0n);

    vi.stubEnv("DOCKER_HOST", DOCKER_HOST);
    vi.stubEnv("DOCKER_CONTEXT", undefined);
    const capacitySamples = new Map<string, { bavail: bigint; bsize: bigint }>();
    const probe = probeDockerStorage({
      statfs: (target) => {
        const sample = fs.statfsSync(target, { bigint: true });
        capacitySamples.set(target, sample);
        return sample;
      },
    });
    expect(probe.ok, probe.ok ? undefined : probe.reason).toBe(true);
    assert(probe.ok);

    const capacityStats = capacitySamples.get(probe.capacity.path);
    assert(capacityStats, `the probe did not sample ${probe.capacity.path}`);
    const measuredAvailableBytes = capacityStats.bavail * capacityStats.bsize;
    expect(probe.capacity.availableBytes).toBe(measuredAvailableBytes);
    expect(probe.capacity.availableBytes).toBeGreaterThan(0n);

    const profile = detectVllmProfile({ platform: "linux", type: "nvidia" });
    assert(profile, "managed vLLM has no generic Linux profile");
    const requiredAvailableBytes = imageStorageRequirementBytes(profile.imageDownloadSizeBytes);
    expect(probe.capacity.availableBytes).toBeGreaterThanOrEqual(requiredAvailableBytes);

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-vllm-storage-"));
    const blockedHome = path.join(fakeBinDir, "blocked-home");
    const commandLogPath = path.join(fakeBinDir, "docker-commands.jsonl");
    const dockerPathResult = spawnSync("sh", ["-c", "command -v docker"], {
      encoding: "utf8",
      env,
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
    let installDockerCommands: string[] = [];
    try {
      fs.writeFileSync(blockedHome, "not a directory\n");
      fs.writeFileSync(path.join(fakeBinDir, "nvidia-smi"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
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
          installChildSource(pathToFileURL(path.resolve("src/lib/inference/vllm.ts")).href),
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
        `managed-vLLM install subprocess failed:\n${installResult.stderr}\n${installResult.stdout}`,
      ).toBe(0);
      expect(installResult.stdout).toContain('NEMOCLAW_INSTALL_RESULT={"ok":false}');
      expect(installResult.stderr).toContain("could not create Hugging Face cache directory");
      expect(installResult.stderr).not.toContain("Docker storage for the managed vLLM image");
      const dockerCommands = fs
        .readFileSync(commandLogPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as string[]);
      expect(dockerCommands.map((args) => args.slice(0, 2))).toEqual([
        ["container", "ls"],
        ["image", "inspect"],
        ["info", "--format"],
      ]);
      installDockerCommands = dockerCommands.map((args) => args.slice(0, 2).join(" "));
    } finally {
      fs.rmSync(fakeBinDir, { force: true, recursive: true });
    }

    const checkoutResult = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
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
      dockerRootAvailableBytes: String(dockerRootAvailableBytes),
      measuredPath: probe.capacity.path,
      measuredSource: probe.capacity.source,
      measuredAvailableBytes: String(probe.capacity.availableBytes),
      imageDownloadSizeBytes: String(profile.imageDownloadSizeBytes),
      requiredAvailableBytes: String(requiredAvailableBytes),
      managedInstallCrossedImageStorageGate: true,
      installSubprocessTimeoutMs: INSTALL_SUBPROCESS_TIMEOUT_MS,
      installDockerCommands,
    };
    writeEvidence(evidence);
    console.info(`[${TARGET_ID}] ${JSON.stringify(evidence)}`);
  },
  30_000,
);
