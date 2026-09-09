// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLEANUP_HELPER_PATH = path.join(REPO_ROOT, ".github", "scripts", "docker-auth-cleanup.sh");
const AUTH_HELPER_PATH = path.join(REPO_ROOT, ".github", "scripts", "docker-auth-setup.sh");
function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

describe("shared Docker Hub authentication workflow boundary (#6961)", () => {
  it("executes the shared auth script with isolated config and bounded fail-closed retries", () => {
    expect(fs.statSync(AUTH_HELPER_PATH).mode & 0o111).not.toBe(0);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-auth-script-"));
    const fakeBin = path.join(directory, "bin");
    const runnerTemp = path.join(directory, "runner-temp");
    const callsPath = path.join(directory, "docker-calls");
    const sleepsPath = path.join(directory, "sleep-calls");
    const tokensPath = path.join(directory, "docker-tokens");
    const githubEnv = path.join(directory, "github-env");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(runnerTemp);
    writeExecutable(
      path.join(fakeBin, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == "30s" ]]\nshift\nexec "$@"\n',
    );
    writeExecutable(
      path.join(fakeBin, "sleep"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$#" -eq 1 && "$1" == "5" ]]\nprintf \'%s\\n\' "$1" >> "${SLEEP_CALLS}"\n',
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${DOCKER_CALLS}"
cat >> "\${DOCKER_TOKENS}"
printf '\\n' >> "\${DOCKER_TOKENS}"
attempt="$(wc -l < "\${DOCKER_CALLS}")"
if [[ "\${attempt}" -lt "\${DOCKER_SUCCESS_ATTEMPT}" ]]; then
  exit 1
fi
`,
    );

    const runAuth = (options: {
      authRequired: "0" | "1";
      successAttempt: number;
      token?: string;
      username?: string;
    }) => {
      fs.rmSync(callsPath, { force: true });
      fs.rmSync(sleepsPath, { force: true });
      fs.rmSync(tokensPath, { force: true });
      fs.rmSync(githubEnv, { force: true });
      return spawnSync(AUTH_HELPER_PATH, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_CALLS: callsPath,
          DOCKER_SUCCESS_ATTEMPT: String(options.successAttempt),
          DOCKER_TOKENS: tokensPath,
          DOCKERHUB_AUTH_REQUIRED: options.authRequired,
          DOCKERHUB_TOKEN: options.token ?? "",
          DOCKERHUB_USERNAME: options.username ?? "",
          GITHUB_ENV: githubEnv,
          GITHUB_JOB: "live",
          PATH: `${fakeBin}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
          SLEEP_CALLS: sleepsPath,
        },
      });
    };

    try {
      const untrusted = runAuth({ authRequired: "0", successAttempt: 1 });
      expect(untrusted.status).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);
      const isolatedConfig = fs.readFileSync(githubEnv, "utf8").trim().split("=")[1];
      expect(isolatedConfig.startsWith(`${runnerTemp}/docker-config-live-`)).toBe(true);
      expect(fs.statSync(isolatedConfig).mode & 0o777).toBe(0o700);
      expect(fs.existsSync(path.join(isolatedConfig, ".nemoclaw-docker-login-attempted"))).toBe(
        false,
      );

      const recovered = runAuth({
        authRequired: "1",
        successAttempt: 4,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(recovered.status, recovered.stderr).toBe(0);
      const authenticatedConfig = fs.readFileSync(githubEnv, "utf8").trim().split("=")[1];
      const authMarker = path.join(authenticatedConfig, ".nemoclaw-docker-login-attempted");
      expect(fs.existsSync(authMarker)).toBe(true);
      expect(fs.statSync(authMarker).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(4);
      expect(fs.readFileSync(callsPath, "utf8")).toContain("--password-stdin");
      expect(fs.readFileSync(callsPath, "utf8")).not.toContain("test-docker-token");
      expect(fs.readFileSync(tokensPath, "utf8").trim().split("\n")).toEqual([
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
      ]);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5"]);

      const recoveredOnFinalAttempt = runAuth({
        authRequired: "1",
        successAttempt: 5,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(recoveredOnFinalAttempt.status, recoveredOnFinalAttempt.stderr).toBe(0);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(5);
      expect(fs.readFileSync(tokensPath, "utf8").trim().split("\n")).toEqual([
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
        "test-docker-token",
      ]);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5", "5"]);

      const exhausted = runAuth({
        authRequired: "1",
        successAttempt: 6,
        token: "test-docker-token",
        username: "test-user",
      });
      expect(exhausted.status).toBe(1);
      expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toHaveLength(5);
      expect(fs.readFileSync(sleepsPath, "utf8").trim().split("\n")).toEqual(["5", "5", "5", "5"]);
      expect(`${exhausted.stdout}${exhausted.stderr}`).toContain(
        "Docker Hub login failed after 5 attempts",
      );

      const missing = runAuth({ authRequired: "1", successAttempt: 1 });
      expect(missing.status).toBe(1);
      expect(fs.existsSync(callsPath)).toBe(false);
      expect(`${missing.stdout}${missing.stderr}`).toContain(
        "Docker Hub credentials are required for trusted E2E runs",
      );

      const rejectedArgs = spawnSync(AUTH_HELPER_PATH, ["unexpected"], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKERHUB_AUTH_REQUIRED: "0",
          GITHUB_ENV: githubEnv,
          GITHUB_JOB: "live",
          PATH: `${fakeBin}:${process.env.PATH}`,
          RUNNER_TEMP: runnerTemp,
        },
      });
      expect(rejectedArgs.status).toBe(1);
      expect(`${rejectedArgs.stdout}${rejectedArgs.stderr}`).toContain("does not accept arguments");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("runs the checked-in cleanup helper only for exact job-owned Docker configs", () => {
    expect(fs.statSync(CLEANUP_HELPER_PATH).mode & 0o111).not.toBe(0);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-cleanup-script-"));
    const fakeBin = path.join(directory, "bin");
    const runnerTemp = path.join(directory, "runner-temp");
    const callsPath = path.join(directory, "docker-calls");
    const sentinelPath = path.join(directory, "command-substitution-ran");
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(runnerTemp);
    writeExecutable(
      path.join(fakeBin, "timeout"),
      '#!/usr/bin/env bash\nset -euo pipefail\n[[ "${1:-}" == "30s" ]]\nshift\nexec "$@"\n',
    );
    writeExecutable(
      path.join(fakeBin, "docker"),
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$*" >> "${DOCKER_CALLS}"\nexit "${DOCKER_EXIT_CODE:-0}"\n',
    );

    const createConfig = (name: string): string => {
      const dockerConfig = path.join(runnerTemp, name);
      fs.mkdirSync(dockerConfig, { recursive: true });
      fs.writeFileSync(path.join(dockerConfig, "config.json"), "{}\n");
      const authMarker = path.join(dockerConfig, ".nemoclaw-docker-login-attempted");
      fs.writeFileSync(authMarker, "");
      fs.chmodSync(authMarker, 0o600);
      return dockerConfig;
    };
    const runCleanup = (options: {
      dockerConfig?: string;
      dockerExitCode?: number;
      githubJob?: string;
      runnerTemp?: string;
    }) => {
      fs.rmSync(callsPath, { force: true });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DOCKER_CALLS: callsPath,
        DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 0),
        GITHUB_JOB: options.githubJob ?? "live",
        PATH: `${fakeBin}:${process.env.PATH}`,
        RUNNER_TEMP: options.runnerTemp ?? runnerTemp,
      };
      delete env.DOCKER_CONFIG;
      Object.assign(
        env,
        options.dockerConfig === undefined ? {} : { DOCKER_CONFIG: options.dockerConfig },
      );
      return spawnSync(CLEANUP_HELPER_PATH, [], {
        encoding: "utf8",
        env,
      });
    };
    const expectRefused = (options: Parameters<typeof runCleanup>[0]) => {
      const result = runCleanup(options);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
      expect(fs.existsSync(callsPath)).toBe(false);
      return result;
    };

    try {
      const empty = runCleanup({});
      expect(empty.status, empty.stderr).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);

      const absentConfig = path.join(runnerTemp, "docker-config-live-Ab12Cd");
      const absent = runCleanup({ dockerConfig: absentConfig });
      expect(absent.status, absent.stderr).toBe(0);
      expect(fs.existsSync(callsPath)).toBe(false);

      const anonymousConfig = path.join(runnerTemp, "docker-config-live-Cd34Ef");
      fs.mkdirSync(anonymousConfig);
      const anonymous = runCleanup({ dockerConfig: anonymousConfig });
      expect(anonymous.status, anonymous.stderr).toBe(0);
      expect(fs.existsSync(anonymousConfig)).toBe(false);
      expect(fs.existsSync(callsPath)).toBe(false);

      const validConfig = createConfig("docker-config-live-Ef34Gh");
      const valid = runCleanup({ dockerConfig: validConfig });
      expect(valid.status, valid.stderr).toBe(0);
      expect(fs.existsSync(validConfig)).toBe(false);
      expect(fs.readFileSync(callsPath, "utf8")).toContain(
        `--config ${validConfig} logout docker.io`,
      );

      const outsideConfig = path.join(directory, "docker-config-live-Ij56Kl");
      fs.mkdirSync(outsideConfig);
      expectRefused({ dockerConfig: outsideConfig });
      expect(fs.existsSync(outsideConfig)).toBe(true);

      const prefixCollision = path.join(`${runnerTemp}-other`, "docker-config-live-Mn78Op");
      fs.mkdirSync(prefixCollision, { recursive: true });
      expectRefused({ dockerConfig: prefixCollision });
      expect(fs.existsSync(prefixCollision)).toBe(true);

      const traversalTarget = path.join(directory, "traversal-target");
      fs.mkdirSync(traversalTarget);
      const traversalConfig = `${runnerTemp}/docker-config-live-Qr90St/../../traversal-target`;
      expectRefused({ dockerConfig: traversalConfig });
      expect(fs.existsSync(traversalTarget)).toBe(true);

      const wrongJobConfig = createConfig("docker-config-other-Uv12Wx");
      expectRefused({ dockerConfig: wrongJobConfig });
      expect(fs.existsSync(wrongJobConfig)).toBe(true);

      const malformedSuffixConfig = createConfig("docker-config-live-short");
      expectRefused({ dockerConfig: malformedSuffixConfig });
      expect(fs.existsSync(malformedSuffixConfig)).toBe(true);

      const symlinkTarget = path.join(directory, "symlink-target");
      fs.mkdirSync(symlinkTarget);
      const configSymlink = path.join(runnerTemp, "docker-config-live-Yz34Ab");
      fs.symlinkSync(symlinkTarget, configSymlink);
      expectRefused({ dockerConfig: configSymlink });
      expect(fs.existsSync(configSymlink)).toBe(true);
      expect(fs.existsSync(symlinkTarget)).toBe(true);

      const configFileTarget = path.join(directory, "external-config.json");
      fs.writeFileSync(configFileTarget, '{"auths":{"docker.io":{}}}\n');
      const configFileSymlinkDir = path.join(runnerTemp, "docker-config-live-Cd56Ef");
      fs.mkdirSync(configFileSymlinkDir);
      const configFileSymlinkMarker = path.join(
        configFileSymlinkDir,
        ".nemoclaw-docker-login-attempted",
      );
      fs.writeFileSync(configFileSymlinkMarker, "");
      fs.chmodSync(configFileSymlinkMarker, 0o600);
      fs.symlinkSync(configFileTarget, path.join(configFileSymlinkDir, "config.json"));
      const configFileSymlink = runCleanup({ dockerConfig: configFileSymlinkDir });
      expect(configFileSymlink.status).toBe(1);
      expect(fs.existsSync(configFileSymlinkDir)).toBe(false);
      expect(fs.readFileSync(configFileTarget, "utf8")).toContain("docker.io");
      expect(fs.existsSync(callsPath)).toBe(false);

      const markerTarget = path.join(directory, "external-login-marker");
      fs.writeFileSync(markerTarget, "preserve me\n");
      const markerSymlinkDir = path.join(runnerTemp, "docker-config-live-Ef67Gh");
      fs.mkdirSync(markerSymlinkDir);
      fs.writeFileSync(path.join(markerSymlinkDir, "config.json"), "{}\n");
      fs.symlinkSync(markerTarget, path.join(markerSymlinkDir, ".nemoclaw-docker-login-attempted"));
      const markerSymlink = runCleanup({ dockerConfig: markerSymlinkDir });
      expect(markerSymlink.status).toBe(1);
      expect(fs.existsSync(markerSymlinkDir)).toBe(false);
      expect(fs.readFileSync(markerTarget, "utf8")).toBe("preserve me\n");
      expect(fs.existsSync(callsPath)).toBe(false);

      const metacharConfig = `${runnerTemp}/docker-config-live-$(touch ${sentinelPath})`;
      expectRefused({ dockerConfig: metacharConfig });
      expect(fs.existsSync(sentinelPath)).toBe(false);

      const logoutFailureConfig = createConfig("docker-config-live-Gh78Ij");
      const logoutFailure = runCleanup({
        dockerConfig: logoutFailureConfig,
        dockerExitCode: 42,
      });
      expect(logoutFailure.status).toBe(1);
      expect(fs.existsSync(logoutFailureConfig)).toBe(false);
      expect(fs.readFileSync(callsPath, "utf8")).toContain(
        `--config ${logoutFailureConfig} logout docker.io`,
      );
      expect(`${logoutFailure.stdout}${logoutFailure.stderr}`).toContain("Docker logout failed");
    } finally {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
