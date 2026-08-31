// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  dockerCapture,
  dockerRun,
  type DockerRunResult,
} from "../../src/lib/adapters/docker/run.js";
import { STOPPED_CHANNEL_CLEANUP_IMAGE } from "../../src/lib/sandbox/privileged-exec.js";
import { testTimeoutOptions } from "../helpers/timeouts.js";

const RUN_DOCKER_E2E = process.env.NEMOCLAW_RUN_STOPPED_CHANNEL_CLEANUP_DOCKER_E2E === "1";
const REPO_ROOT = path.join(import.meta.dirname, "../..");
const WECHAT_STATE_PATHS = [
  "/sandbox/.openclaw/wechat",
  "/sandbox/.openclaw/openclaw-weixin",
] as const;

function runDocker(args: readonly string[], timeout = 30_000): DockerRunResult {
  return dockerRun(args, {
    encoding: "utf8",
    ignoreError: true,
    suppressOutput: true,
    timeout,
  });
}

function expectDockerSuccess(result: DockerRunResult, operation: string): void {
  const details = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n");
  expect(result.status, `${operation} failed\n${details}`).toBe(0);
}

function cleanupDriverSource(): string {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, "src/lib/sandbox/privileged-exec.ts")).href;
  return `
import { clearStoppedDockerSandboxChannelState } from ${JSON.stringify(moduleUrl)};
const sandboxName = process.env.NEMOCLAW_TEST_SANDBOX_NAME;
if (!sandboxName) throw new Error("missing sandbox fixture name");
const result = clearStoppedDockerSandboxChannelState(sandboxName, ${JSON.stringify(WECHAT_STATE_PATHS)});
process.stdout.write(JSON.stringify(result));
`;
}

function cleanupDriverEnv(home: string, stateDir: string, sandboxName: string): NodeJS.ProcessEnv {
  return {
    DOCKER_HOST: process.env.DOCKER_HOST,
    HOME: home,
    LANG: "C.UTF-8",
    NEMOCLAW_TEST_SANDBOX_NAME: sandboxName,
    NEMOCLAW_TEST_STATE_DIR: stateDir,
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
}

describe.runIf(RUN_DOCKER_E2E)("stopped channel cleanup Docker lifecycle", () => {
  it(
    "removes only WeChat state from an existing stopped overlay2 sandbox",
    testTimeoutOptions(180_000),
    () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stopped-cleanup-docker-"));
      const home = path.join(fixture, "home");
      const stateDir = path.join(fixture, "state");
      const sandboxName = `cleanup-runtime-${process.pid}-${Date.now().toString(36)}`;
      const containerName = `openshell-${sandboxName}`;
      const helperName = `nemoclaw-channel-cleanup-${createHash("sha256")
        .update(sandboxName)
        .digest("hex")
        .slice(0, 24)}`;

      fs.mkdirSync(path.join(home, ".nemoclaw"), { mode: 0o700, recursive: true });
      fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
      fs.writeFileSync(
        path.join(home, ".nemoclaw", "sandboxes.json"),
        JSON.stringify({
          defaultSandbox: sandboxName,
          sandboxes: {
            [sandboxName]: {
              gpuEnabled: false,
              model: "test-model",
              name: sandboxName,
              openshellDriver: "docker",
              policies: [],
              provider: "nvidia-prod",
            },
          },
        }),
        { mode: 0o600 },
      );

      try {
        expectDockerSuccess(
          runDocker(["pull", STOPPED_CHANNEL_CLEANUP_IMAGE], 120_000),
          "pull the cleanup helper image",
        );
        const created = runDocker([
          "create",
          "--name",
          containerName,
          "--label",
          "openshell.ai/managed-by=openshell",
          "--label",
          `openshell.ai/sandbox-name=${sandboxName}`,
          "--entrypoint",
          "/usr/local/bin/node",
          STOPPED_CHANNEL_CLEANUP_IMAGE,
          "-e",
          "setInterval(() => {}, 2147483647)",
        ]);
        expectDockerSuccess(created, "create the sandbox container");
        const containerId = String(created.stdout).trim();
        expect(containerId).toMatch(/^[a-f0-9]{64}$/u);
        expectDockerSuccess(runDocker(["start", containerId]), "start the sandbox container");

        const seedScript = `
const fs = require("node:fs");
for (const directory of ${JSON.stringify(WECHAT_STATE_PATHS)}) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync("/sandbox/.openclaw/wechat/session.json", "remove\\n");
fs.writeFileSync("/sandbox/.openclaw/openclaw-weixin/session.json", "remove\\n");
fs.writeFileSync("/sandbox/unrelated.txt", "preserve\\n");
`;
        expectDockerSuccess(
          runDocker(["exec", containerId, "/usr/local/bin/node", "-e", seedScript]),
          "seed sandbox state",
        );
        expectDockerSuccess(runDocker(["stop", containerId]), "stop the sandbox container");

        const inspection = dockerCapture(
          [
            "inspect",
            "--format",
            "{{.GraphDriver.Name}}\t{{.GraphDriver.Data.UpperDir}}\t{{json .Mounts}}",
            containerId,
          ],
          { timeout: 30_000 },
        );
        const [driver, upperDir, mountsJson] = inspection.split("\t");
        expect(driver).toBe("overlay2");
        expect(path.isAbsolute(upperDir ?? "")).toBe(true);
        expect(
          (JSON.parse(mountsJson ?? "[]") as Array<{ Destination?: string }>).some(
            (mount) => mount.Destination === "/sandbox",
          ),
        ).toBe(false);

        const cleanupResult = spawnSync(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", cleanupDriverSource()],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            env: cleanupDriverEnv(home, stateDir, sandboxName),
            timeout: 60_000,
          },
        );
        expect(cleanupResult.status, cleanupResult.stderr).toBe(0);
        expect(JSON.parse(cleanupResult.stdout)).toEqual({ cleared: true });

        expectDockerSuccess(runDocker(["start", containerId]), "restart the sandbox container");
        const observed = JSON.parse(
          dockerCapture(
            [
              "exec",
              containerId,
              "/usr/local/bin/node",
              "-e",
              `
const fs = require("node:fs");
process.stdout.write(JSON.stringify({
  unrelated: fs.readFileSync("/sandbox/unrelated.txt", "utf8"),
  wechat: fs.existsSync("/sandbox/.openclaw/wechat"),
  weixin: fs.existsSync("/sandbox/.openclaw/openclaw-weixin"),
}));
`,
            ],
            { timeout: 30_000 },
          ),
        );
        expect(observed).toEqual({ unrelated: "preserve\n", wechat: false, weixin: false });
      } finally {
        runDocker(["rm", "-f", helperName]);
        runDocker(["rm", "-f", containerName]);
        fs.rmSync(fixture, { force: true, recursive: true });
      }
    },
  );
});
