// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import * as importedGatewayEnv from "../../../src/lib/onboard/docker-driver-gateway-env.ts";
import * as importedGatewayLocalTls from "../../../src/lib/onboard/docker-driver-gateway-local-tls.ts";
import * as importedPortableHostPreparation from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";
import * as importedSandboxPrebuild from "../../../src/lib/onboard/sandbox-prebuild.ts";
import * as importedBuildContext from "../../../src/lib/sandbox/build-context.ts";
import { test } from "../fixtures/e2e-test.ts";
import {
  cleanupPortableProfileRootlessFixture,
  installPortableProfileSystemctlShim,
} from "../fixtures/portable-profile-systemctl.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { verifyPinnedPodmanGatewayStarts } from "./portable-profile-gateway-proof.ts";

const gatewayEnvModule = (
  "default" in importedGatewayEnv && importedGatewayEnv.default
    ? importedGatewayEnv.default
    : importedGatewayEnv
) as typeof import("../../../src/lib/onboard/docker-driver-gateway-env.ts");
const gatewayLocalTlsModule = (
  "default" in importedGatewayLocalTls && importedGatewayLocalTls.default
    ? importedGatewayLocalTls.default
    : importedGatewayLocalTls
) as typeof import("../../../src/lib/onboard/docker-driver-gateway-local-tls.ts");
const portableHostPreparationModule = (
  "default" in importedPortableHostPreparation && importedPortableHostPreparation.default
    ? importedPortableHostPreparation.default
    : importedPortableHostPreparation
) as typeof import("../../../src/lib/onboard/experimental/portable-host-preparation.ts");
const sandboxPrebuildModule = (
  "default" in importedSandboxPrebuild && importedSandboxPrebuild.default
    ? importedSandboxPrebuild.default
    : importedSandboxPrebuild
) as typeof import("../../../src/lib/onboard/sandbox-prebuild.ts");
const buildContextModule = (
  "default" in importedBuildContext && importedBuildContext.default
    ? importedBuildContext.default
    : importedBuildContext
) as typeof import("../../../src/lib/sandbox/build-context.ts");

const { buildDockerDriverGatewayEnv } = gatewayEnvModule;
const { ensureDockerDriverGatewayLocalTlsBundle } = gatewayLocalTlsModule;
const { preparePortableExperimentalHost } = portableHostPreparationModule;
const { prebuildSandboxImageIfEligible } = sandboxPrebuildModule;
const { SANDBOX_BUILD_CONTEXT_PREFIX } = buildContextModule;

const BASE_IMAGE =
  "docker.io/library/ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const PORTABLE_PROFILE_E2E_PHASES = [
  "select the Podman-reported runtime socket",
  "prepare the rootless container runtime",
  "build and publish the sandbox image",
  "start the pinned Podman gateway",
  "verify the fixed host route",
  "record portable environment completion",
] as const;

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    env: process.env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 55_000,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${String(result.error?.message || result.stderr || result.stdout)}`,
  );
  return String(result.stdout).trim();
}

async function waitForRegistry(attempt = 0): Promise<void> {
  assert.ok(attempt < 60, "The managed local registry did not become ready.");
  const ready = await new Promise<boolean>((resolve) => {
    const request = http.get("http://127.0.0.1:5000/v2/", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    request.once("error", () => resolve(false));
    request.setTimeout(500, () => {
      request.destroy();
      resolve(false);
    });
  });
  return ready
    ? undefined
    : new Promise<void>((resolve) => setTimeout(resolve, 250)).then(() =>
        waitForRegistry(attempt + 1),
      );
}

function selectInstallerPodmanRuntime(repoRoot: string): string {
  const payload = path.join(repoRoot, "scripts", "install.sh");
  const script = [
    `source "${payload}" >/dev/null 2>&1 || true`,
    'export NEMOCLAW_EXPERIMENTAL_PROFILE="portable"',
    "prepare_portable_experimental_runtime_override >&2",
    'printf "%s" "$DOCKER_HOST"',
  ].join("\n");
  return run("bash", ["-c", script]);
}

async function main(progress: TestProgress): Promise<void> {
  assert.equal(process.platform, "linux", "portable profile E2E requires Linux");
  assert.notEqual(process.getuid?.(), 0, "portable profile E2E must run without root privileges");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-e2e-"));
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "gateway-state");
  const configHome = path.join(home, ".config");
  const runtimeDir = `/run/user/${String(process.getuid?.())}`;
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  installPortableProfileSystemctlShim(binDir);

  Object.assign(process.env, {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_RUNTIME_DIR: runtimeDir,
    NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
    NEMOCLAW_SANDBOX_PREBUILD: "1",
  });

  try {
    progress.phase("select the Podman-reported runtime socket");
    const installerDockerHost = selectInstallerPodmanRuntime(process.cwd());
    assert.equal(installerDockerHost, `unix://${runtimeDir}/podman/podman.sock`);

    progress.phase("prepare the rootless container runtime");
    preparePortableExperimentalHost(process.env);
    assert.equal(process.env.DOCKER_HOST, `unix://${runtimeDir}/podman/podman.sock`);
    assert.equal(fs.statSync(path.join(runtimeDir, "podman")).mode & 0o777, 0o700);
    assert.match(
      fs.readFileSync(String(process.env.CONTAINERS_CONF), "utf-8"),
      /default_rootless_network_cmd = "pasta"/,
    );

    const podmanInfo = JSON.parse(run("podman", ["info", "--format", "json"]));
    assert.equal(podmanInfo.host?.security?.rootless, true, "Podman must be rootless");
    run("docker", ["version"]);
    await waitForRegistry();

    progress.phase("build and publish the sandbox image");
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), SANDBOX_BUILD_CONTEXT_PREFIX));
    fs.chmodSync(buildCtx, 0o700);
    const dockerfile = path.join(buildCtx, "Dockerfile");
    fs.writeFileSync(
      dockerfile,
      `FROM ${BASE_IMAGE}\nRUN printf 'portable-profile-image\\n' >/etc/nemoclaw-profile\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    const prebuild = await prebuildSandboxImageIfEligible({
      buildCtx,
      buildId: "rootless-e2e",
      createArgs: ["--from", dockerfile, "--name", "portable-e2e"],
      sandboxName: "portable-e2e",
      dockerDriverGateway: true,
      env: process.env,
      origin: "generated",
      log: console.log,
    });
    assert.equal(
      prebuild.imageRef,
      "localhost:5000/nemoclaw-sandbox-local:portable-e2e-rootless-e2e",
    );

    run("podman", ["image", "rm", "--force", prebuild.imageRef]);
    run("podman", ["pull", prebuild.imageRef]);
    assert.match(
      run("podman", ["image", "inspect", "--format", "{{.Id}}", prebuild.imageRef]),
      /^(?:sha256:)?[a-f0-9]{64}$/,
    );
    run("podman", ["network", "create", "--subnet", "169.254.1.0/24", "openshell-docker"]);
    run("podman", [
      "network",
      "connect",
      "--ip",
      "169.254.1.2",
      "openshell-docker",
      "nemoclaw-portable-registry",
    ]);

    const gatewayBin = run("bash", ["-lc", "command -v openshell-gateway"]);
    const sandboxBin = run("bash", ["-lc", "command -v openshell-sandbox"]);
    const gatewayEnv = buildDockerDriverGatewayEnv({
      platform: "linux",
      gatewayPort: 8080,
      stateDir,
      podmanSocketPath: `${runtimeDir}/podman/podman.sock`,
      getDockerSupervisorImage: () => "supervisor:e2e-not-launched",
      resolveSandboxBin: () => sandboxBin,
    });
    assert.equal(gatewayEnv.OPENSHELL_DRIVERS, "podman");
    assert.equal(gatewayEnv.OPENSHELL_BIND_ADDRESS, "0.0.0.0");
    assert.equal(gatewayEnv.OPENSHELL_GRPC_ENDPOINT, "https://169.254.1.2:8080");
    assert.match(
      fs.readFileSync(gatewayEnv.OPENSHELL_GATEWAY_CONFIG, "utf-8"),
      /host_gateway_ip = "169\.254\.1\.2"/,
    );
    assert.match(
      fs.readFileSync(gatewayEnv.OPENSHELL_GATEWAY_CONFIG, "utf-8"),
      new RegExp(`socket_path = "${runtimeDir}/podman/podman[.]sock"`),
    );
    assert.doesNotMatch(
      fs.readFileSync(gatewayEnv.OPENSHELL_GATEWAY_CONFIG, "utf-8"),
      /supervisor_bin/,
    );

    progress.phase("start the pinned Podman gateway");
    ensureDockerDriverGatewayLocalTlsBundle({ gatewayBin, stateDir });
    await verifyPinnedPodmanGatewayStarts(gatewayBin, gatewayEnv, progress);

    progress.phase("verify the fixed host route");

    const routeProof = [
      "exec 3<>/dev/tcp/169.254.1.2/5000",
      "printf 'GET /v2/ HTTP/1.1\\r\\nHost: portable-profile\\r\\nConnection: close\\r\\n\\r\\n' >&3",
      "response=$(cat <&3)",
      'grep -F "200 OK" <<<"$response"',
    ].join("; ");
    assert.equal(
      run("podman", [
        "run",
        "--rm",
        "--network",
        "openshell-docker",
        prebuild.imageRef,
        "timeout",
        "15",
        "bash",
        "-lc",
        routeProof,
      ]),
      "HTTP/1.1 200 OK",
    );

    progress.phase("record portable environment completion");
    console.log("Portable profile rootless environment E2E passed.");
  } finally {
    spawnSync("podman", ["rm", "--force", "nemoclaw-portable-registry"], {
      env: process.env,
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: 15_000,
    });
    spawnSync("podman", ["system", "reset", "--force"], {
      env: process.env,
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: 15_000,
    });
    await cleanupPortableProfileRootlessFixture(runtimeDir, root);
  }
}

test(
  "portable profile rootless environment completes the local image and fixed-host route contracts",
  {
    meta: { e2ePhases: PORTABLE_PROFILE_E2E_PHASES },
    timeout: 120_000,
  },
  async ({ progress }) => {
    await main(progress);
  },
);
