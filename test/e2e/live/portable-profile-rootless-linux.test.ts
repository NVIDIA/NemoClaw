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
import * as importedBuildContextStage from "../../../src/lib/onboard/build-context-stage.ts";
import * as importedHermesBuildContext from "../../../src/lib/onboard/experimental/hermes-portable-build-context.ts";
import * as importedPortableHostPreparation from "../../../src/lib/onboard/experimental/portable-host-preparation.ts";
import * as importedSandboxPrebuild from "../../../src/lib/onboard/sandbox-prebuild.ts";
import * as importedBuildContext from "../../../src/lib/sandbox/build-context.ts";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
  PORTABLE_DOCKER_NETWORK_NAME,
  PORTABLE_DOCKER_NETWORK_SUBNET,
  PORTABLE_HOST_GATEWAY_IP,
  PORTABLE_REGISTRY_IP,
} from "../../../src/lib/onboard/docker-driver-platform.ts";
import { test } from "../fixtures/e2e-test.ts";
import {
  cleanupPortableHostGatewayAlias,
  cleanupPortableProfileRootlessFixture,
  installPortableProfileSystemctlShim,
} from "../fixtures/portable-profile-systemctl.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import {
  getSandboxConfigRequest,
  mintSandboxJwt,
  runSandboxTokenContainerProbe,
} from "./openshell-gateway-auth-probe.ts";
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
const buildContextStageModule = (
  "default" in importedBuildContextStage && importedBuildContextStage.default
    ? importedBuildContextStage.default
    : importedBuildContextStage
) as typeof import("../../../src/lib/onboard/build-context-stage.ts");
const portableHostPreparationModule = (
  "default" in importedPortableHostPreparation && importedPortableHostPreparation.default
    ? importedPortableHostPreparation.default
    : importedPortableHostPreparation
) as typeof import("../../../src/lib/onboard/experimental/portable-host-preparation.ts");
const hermesBuildContextModule = (
  "default" in importedHermesBuildContext && importedHermesBuildContext.default
    ? importedHermesBuildContext.default
    : importedHermesBuildContext
) as typeof import("../../../src/lib/onboard/experimental/hermes-portable-build-context.ts");
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
const { stageCreateSandboxBuildContext } = buildContextStageModule;
const { preparePortableExperimentalHost } = portableHostPreparationModule;
const { createHermesPortableBuildContextPlan } = hermesBuildContextModule;
const { prebuildSandboxImageIfEligible } = sandboxPrebuildModule;
const { SANDBOX_BUILD_CONTEXT_PREFIX } = buildContextModule;

const BASE_IMAGE =
  "docker.io/library/ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const HERMES_PORTABLE_E2E_SANDBOX_NAME = "hermes-portable-e2e";
const HERMES_PORTABLE_E2E_TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const HERMES_PORTABLE_E2E_CREATE_INTENT = "b".repeat(64);
const HERMES_PORTABLE_E2E_BUILD_SETTINGS = {
  model: "qwen3-vl:4b",
  provider: "ollama-local",
  preferredInferenceApi: "openai-completions",
  toolDisclosure: "direct",
} as const;
const PORTABLE_PROFILE_E2E_PHASES = [
  "select the Podman-reported runtime socket",
  "prepare the rootless container runtime",
  "verify immutable non-force network removal",
  "build and publish the sandbox image",
  "prepare the staged Hermes build context",
  "build and publish the staged Hermes image",
  "verify Hermes accepts the configured external Host",
  "start the pinned Podman gateway",
  "verify distinct same-network routes",
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

function probeHermesDashboardHttp(containerName: string, host: string) {
  return spawnSync(
    "podman",
    [
      "exec",
      containerName,
      "curl",
      "--silent",
      "--show-error",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--max-time",
      "2",
      "--noproxy",
      "*",
      "--header",
      `Host: ${host}`,
      "http://127.0.0.1:29443/",
    ],
    {
      encoding: "utf-8",
      env: process.env,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
}

async function waitForHermesDashboard(containerName: string, attempt = 0): Promise<void> {
  const timeoutDetail = attempt < 60 ? "" : `\n${run("podman", ["logs", containerName])}`;
  assert.ok(attempt < 60, `Hermes dashboard did not become ready:${timeoutDetail}`);
  const response = probeHermesDashboardHttp(containerName, "nemoclaw0-abc123.brevlab.com");
  const ready = response.status === 0 && response.stdout.trim() === "200";
  const running = ready
    ? undefined
    : spawnSync(
        "podman",
        ["container", "inspect", "--format", "{{.State.Running}}", containerName],
        {
          encoding: "utf-8",
          env: process.env,
          killSignal: "SIGKILL",
          timeout: 15_000,
        },
      );
  const runningOrReady = ready || (running?.status === 0 && running.stdout.trim() === "true");
  const exitDetail = runningOrReady ? "" : `\n${run("podman", ["logs", containerName])}`;
  assert.equal(
    runningOrReady,
    true,
    `Hermes dashboard container exited before readiness:${exitDetail}`,
  );
  return ready
    ? undefined
    : new Promise<void>((resolve) => setTimeout(resolve, 500)).then(() =>
        waitForHermesDashboard(containerName, attempt + 1),
      );
}

async function probeHermesDashboardProxyRoute(imageRef: string): Promise<Record<string, number>> {
  const containerName = `hermes-dashboard-host-${String(process.pid)}-${String(Date.now())}`;
  const containerId = run("podman", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--network",
    "none",
    "--user",
    "sandbox",
    "--env",
    "CHAT_UI_URL=https://NEMOCLAW0-ABC123.BREVLAB.COM.:29443/dashboard",
    "--entrypoint",
    "/bin/sh",
    imageRef,
    "-c",
    "exec /usr/local/bin/nemoclaw-start",
  ]);
  assert.match(containerId, /^[a-f0-9]{64}$/u);
  try {
    await waitForHermesDashboard(containerName);

    const hosts = {
      external: "nemoclaw0-abc123.brevlab.com",
      externalPort: "nemoclaw0-abc123.brevlab.com:443",
      loopback: "localhost:29443",
      lookalike: "nemoclaw0-abc123.brevlab.com.attacker.test",
      other: "attacker.test",
    } as const;
    return Object.fromEntries(
      Object.entries(hosts).map(([name, host]) => {
        const response = probeHermesDashboardHttp(containerName, host);
        assert.equal(response.status, 0, response.stderr || response.stdout);
        return [name, Number(response.stdout.trim())];
      }),
    );
  } finally {
    run("podman", ["container", "rm", "--force", containerName]);
  }
}

function assertHermesDashboardStartupRefusal(imageRef: string, chatUiUrl: string) {
  const refusal = spawnSync(
    "podman",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "sandbox",
      "--env",
      `CHAT_UI_URL=${chatUiUrl}`,
      "--entrypoint",
      "/usr/local/bin/nemoclaw-start",
      imageRef,
      "/bin/true",
    ],
    {
      encoding: "utf-8",
      env: process.env,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    },
  );
  assert.equal(refusal.status, 1, refusal.stderr || refusal.stdout);
  assert.match(refusal.stderr, /Invalid CHAT_UI_URL for the Hermes dashboard/u);
  assert.match(
    refusal.stderr,
    /Set CHAT_UI_URL and rerun onboarding before starting the sandbox\./u,
  );
  assert.equal(refusal.stderr.includes(chatUiUrl), false);
}

function parseOnePodmanRecord(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(Array.isArray(parsed), `${label} must be a JSON array`);
  assert.equal(parsed.length, 1, `${label} must contain one record`);
  const record = parsed[0];
  assert.ok(record && typeof record === "object" && !Array.isArray(record), `${label} is invalid`);
  return record as Record<string, unknown>;
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
  const sourceRevision = process.env.E2E_SOURCE_REVISION ?? "";
  assert.match(
    sourceRevision,
    /^[a-f0-9]{40}$/u,
    "E2E_SOURCE_REVISION must identify the exact candidate commit",
  );
  assert.equal(run("git", ["rev-parse", "HEAD"]), sourceRevision);

  const root = fs.mkdtempSync(path.join(os.userInfo().homedir, ".nemoclaw-portable-e2e-"));
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "gateway-state");
  const configHome = path.join(home, ".config");
  const runtimeDir = `/run/user/${String(process.getuid?.())}`;
  const disposableNetworkName = `nemoclaw-portable-id-proof-${String(process.pid)}`;
  let disposableNetworkCreated = false;
  let disposableNetworkId: string | null = null;
  let disposableNetworkSubnet: string | null = null;
  let disposableNetworkInterface: string | null = null;
  let hermesImageId: string | null = null;
  let hermesContextRetired = false;
  const gatewayAliasPresentBefore = run("ip", ["-o", "-4", "address", "show", "dev", "lo"])
    .split("\n")
    .some((line) => line.includes(`inet ${PORTABLE_HOST_GATEWAY_IP}/32`));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
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
    const prepared = preparePortableExperimentalHost(process.env, { home });
    assert.equal(prepared?.authority.configHome, configHome);
    assert.equal(process.env.DOCKER_HOST, `unix://${runtimeDir}/podman/podman.sock`);
    assert.equal(fs.statSync(path.join(runtimeDir, "podman")).mode & 0o777, 0o700);
    assert.match(
      fs.readFileSync(String(process.env.CONTAINERS_CONF), "utf-8"),
      /default_rootless_network_cmd = "pasta"/,
    );
    const registryConfig = path.join(
      configHome,
      "containers/registries.conf.d/99-nemoclaw-portable.conf",
    );
    assert.equal(
      fs.readFileSync(registryConfig, "utf-8"),
      '[[registry]]\nlocation = "localhost:5000"\ninsecure = true\n',
    );
    assert.match(
      run("ip", ["-o", "-4", "address", "show", "dev", "lo"]),
      new RegExp(`\\binet ${PORTABLE_HOST_GATEWAY_IP.replaceAll(".", "\\.")}/32\\b`),
    );

    const podmanInfo = JSON.parse(run("podman", ["info", "--format", "json"]));
    assert.equal(podmanInfo.host?.security?.rootless, true, "Podman must be rootless");
    run("docker", ["version"]);
    await waitForRegistry();

    progress.phase("verify immutable non-force network removal");
    const verifiedPodmanUrl = String(process.env.DOCKER_HOST);
    assert.equal(verifiedPodmanUrl, `unix://${runtimeDir}/podman/podman.sock`);
    // Netavark rejects the retired link-local subnet before this pinned runtime can create it.
    // Deterministic tests own that state; this live boundary proves the emitted full-ID form.
    run("podman", ["--url", verifiedPodmanUrl, "network", "create", disposableNetworkName]);
    disposableNetworkCreated = true;
    const disposableNetwork = parseOnePodmanRecord(
      run("podman", ["--url", verifiedPodmanUrl, "network", "inspect", disposableNetworkName]),
      "disposable network inspection",
    );
    assert.equal(disposableNetwork.name, disposableNetworkName);
    assert.equal(disposableNetwork.driver, "bridge");
    assert.equal(disposableNetwork.dns_enabled, true);
    assert.match(String(disposableNetwork.network_interface), /^podman(?:0|[1-9][0-9]{0,8})$/u);
    assert.equal(Object.hasOwn(disposableNetwork, "network_dns_servers"), false);
    assert.match(String(disposableNetwork.id), /^[a-f0-9]{64}$/u);
    assert.ok(Array.isArray(disposableNetwork.subnets));
    assert.equal(disposableNetwork.subnets.length, 1);
    const disposableSubnet = disposableNetwork.subnets[0] as Record<string, unknown>;
    assert.equal(typeof disposableSubnet.subnet, "string");
    assert.equal(Object.hasOwn(disposableSubnet, "lease_range"), false);
    assert.notEqual(disposableSubnet.subnet, "169.254.1.0/24");
    disposableNetworkId = String(disposableNetwork.id);
    disposableNetworkSubnet = String(disposableSubnet.subnet);
    disposableNetworkInterface = String(disposableNetwork.network_interface);
    run("podman", ["--url", verifiedPodmanUrl, "network", "rm", disposableNetworkId]);
    disposableNetworkCreated = false;
    const absentInspection = spawnSync(
      "podman",
      ["--url", verifiedPodmanUrl, "network", "inspect", disposableNetworkId],
      {
        encoding: "utf-8",
        env: process.env,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    );
    assert.equal(absentInspection.error, undefined);
    assert.notEqual(absentInspection.status, 0);
    const remainingNetworkIds = run("podman", [
      "--url",
      verifiedPodmanUrl,
      "network",
      "ls",
      "--no-trunc",
      "--format",
      "{{.ID}}",
    ])
      .split("\n")
      .filter(Boolean);
    assert.ok(remainingNetworkIds.every((id) => /^[a-f0-9]{64}$/u.test(id)));
    assert.ok(!remainingNetworkIds.includes(disposableNetworkId));

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
    const imageRef = prebuild.imageRef;
    assert.equal(imageRef, "localhost:5000/nemoclaw-sandbox-local:portable-e2e-rootless-e2e");

    run("podman", ["image", "rm", "--force", imageRef]);
    run("podman", ["pull", imageRef]);
    assert.match(
      run("podman", ["image", "inspect", "--format", "{{.Id}}", imageRef]),
      /^(?:sha256:)?[a-f0-9]{64}$/,
    );

    progress.phase("prepare the staged Hermes build context");
    const hermesContextStateDir = path.join(root, "hermes-build-state");
    fs.mkdirSync(hermesContextStateDir, { mode: 0o700 });
    const hermesContextInput = {
      sandboxName: HERMES_PORTABLE_E2E_SANDBOX_NAME,
      transactionId: HERMES_PORTABLE_E2E_TRANSACTION_ID,
      createIntentSha256: HERMES_PORTABLE_E2E_CREATE_INTENT,
      stateDir: hermesContextStateDir,
    };
    const hermesContextPlan = createHermesPortableBuildContextPlan(
      fs.realpathSync(process.cwd()),
      HERMES_PORTABLE_E2E_BUILD_SETTINGS,
    );
    const hermesContext = hermesContextPlan.materialize(hermesContextInput);
    let hermesImageRef: string | null = null;
    let cleanupHermesTemporaryBuildContext = (): boolean => true;
    try {
      hermesContext.assertCurrent();
      const hermesTemporaryBuildContext = stageCreateSandboxBuildContext({
        root: fs.realpathSync(process.cwd()),
        fromDockerfile: hermesContext.dockerfilePath,
        agent: null,
        createAgentSandbox: () => {
          throw new Error("Hermes Portable E2E must stage the reviewed durable context.");
        },
        log: console.log,
      });
      cleanupHermesTemporaryBuildContext = hermesTemporaryBuildContext.cleanupBuildCtx;

      progress.phase("build and publish the staged Hermes image");
      const hermesPrebuild = await prebuildSandboxImageIfEligible({
        buildCtx: hermesTemporaryBuildContext.buildCtx,
        buildId: "hermes-rootless-e2e",
        createArgs: [
          "--from",
          hermesTemporaryBuildContext.stagedDockerfile,
          "--name",
          HERMES_PORTABLE_E2E_SANDBOX_NAME,
        ],
        sandboxName: HERMES_PORTABLE_E2E_SANDBOX_NAME,
        dockerDriverGateway: true,
        env: process.env,
        origin: "generated",
        log: console.log,
      });
      assert.ok(hermesPrebuild.imageRef, "The staged Hermes image was not built.");
      assert.ok(hermesPrebuild.imageId, "The staged Hermes image identity was not proven.");
      hermesImageRef = hermesPrebuild.imageRef;
      assert.equal(hermesPrebuild.createArgs[1], hermesImageRef);
      const inspectedHermesImageId = run("podman", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        hermesImageRef,
      ]).toLowerCase();
      assert.match(inspectedHermesImageId, /^(?:sha256:)?[a-f0-9]{64}$/);
      assert.equal(
        inspectedHermesImageId.replace(/^sha256:/u, ""),
        hermesPrebuild.imageId.replace(/^sha256:/u, ""),
      );
      hermesImageId = inspectedHermesImageId;
      run("podman", [
        "run",
        "--rm",
        "--entrypoint",
        "/bin/sh",
        hermesImageRef,
        "-c",
        "test ! -e /scripts/hermes-dashboard-external-host.patch",
      ]);

      progress.phase("verify Hermes accepts the configured external Host");
      assert.deepEqual(await probeHermesDashboardProxyRoute(hermesImageRef), {
        external: 200,
        externalPort: 200,
        loopback: 200,
        lookalike: 400,
        other: 400,
      });

      assertHermesDashboardStartupRefusal(hermesImageRef, "http://dashboard.example.test:29443");
      assertHermesDashboardStartupRefusal(hermesImageRef, "https://0.0.0.0:29443");
      assertHermesDashboardStartupRefusal(
        hermesImageRef,
        "https://user@dashboard.example.test:29443",
      );
      assertHermesDashboardStartupRefusal(hermesImageRef, "https://dashboard.example.test:invalid");
      assertHermesDashboardStartupRefusal(hermesImageRef, "https://./");
    } finally {
      try {
        hermesImageRef && run("podman", ["image", "rm", "--force", hermesImageRef]);
      } finally {
        try {
          assert.equal(cleanupHermesTemporaryBuildContext(), true);
        } finally {
          hermesContextRetired = hermesContextPlan.retire(hermesContextInput);
          assert.equal(hermesContextRetired, true);
        }
      }
    }
    assert.deepEqual(
      parseDockerNetworkIpamEntries(
        run("docker", [
          "network",
          "inspect",
          "--format",
          DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
          PORTABLE_DOCKER_NETWORK_NAME,
        ]),
      )?.map(({ subnet }) => subnet),
      [PORTABLE_DOCKER_NETWORK_SUBNET],
    );
    assert.equal(
      run("docker", [
        "inspect",
        "--format",
        `{{with index .NetworkSettings.Networks ${JSON.stringify(PORTABLE_DOCKER_NETWORK_NAME)}}}{{.IPAddress}}{{end}}`,
        "nemoclaw-portable-registry",
      ]),
      PORTABLE_REGISTRY_IP,
    );
    const currentNetwork = parseOnePodmanRecord(
      run("podman", [
        "--url",
        verifiedPodmanUrl,
        "network",
        "inspect",
        PORTABLE_DOCKER_NETWORK_NAME,
      ]),
      "portable network inspection",
    );
    assert.match(String(currentNetwork.id), /^[a-f0-9]{64}$/u);
    const currentRegistry = parseOnePodmanRecord(
      run("podman", [
        "--url",
        verifiedPodmanUrl,
        "container",
        "inspect",
        "nemoclaw-portable-registry",
      ]),
      "portable registry inspection",
    );
    assert.match(String(currentRegistry.Id), /^[a-f0-9]{64}$/u);
    assert.equal(currentRegistry.Name, "nemoclaw-portable-registry");

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
    assert.equal(gatewayEnv.OPENSHELL_GRPC_ENDPOINT, `https://${PORTABLE_HOST_GATEWAY_IP}:8080`);
    assert.match(
      fs.readFileSync(gatewayEnv.OPENSHELL_GATEWAY_CONFIG, "utf-8"),
      new RegExp(`host_gateway_ip = "${PORTABLE_HOST_GATEWAY_IP.replaceAll(".", "\\.")}"`),
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
    await verifyPinnedPodmanGatewayStarts(gatewayBin, gatewayEnv, progress, async () => {
      progress.phase("verify distinct same-network routes");
      const sandboxId = "portable-e2e";
      const sandboxToken = mintSandboxJwt({
        configPath: gatewayEnv.OPENSHELL_GATEWAY_CONFIG,
        sandboxId,
      });
      const gatewayProbe = runSandboxTokenContainerProbe({
        authorization: `Bearer ${sandboxToken}`,
        dockerBin: "podman",
        hostGatewayIp: PORTABLE_HOST_GATEWAY_IP,
        networkName: PORTABLE_DOCKER_NETWORK_NAME,
        payload: getSandboxConfigRequest(sandboxId),
        port: 8080,
        stateDir,
      });
      assert.equal(gatewayProbe.status, 0, "The authenticated same-network gateway probe failed.");
      const gatewayResult = JSON.parse(gatewayProbe.stdout) as {
        grpcStatus?: string;
        httpStatus?: number;
      };
      assert.equal(gatewayResult.httpStatus, 200);
      assert.ok(gatewayResult.grpcStatus);
      assert.ok(!["7", "16"].includes(gatewayResult.grpcStatus));

      const registryRouteProof = [
        `exec 3<>/dev/tcp/${PORTABLE_REGISTRY_IP}/5000`,
        "printf 'GET /v2/ HTTP/1.1\\r\\nHost: portable-profile\\r\\nConnection: close\\r\\n\\r\\n' >&3",
        "response=$(cat <&3)",
        'grep -F "200 OK" <<<"$response"',
      ].join("; ");
      assert.equal(
        run("podman", [
          "run",
          "--rm",
          "--network",
          PORTABLE_DOCKER_NETWORK_NAME,
          imageRef,
          "timeout",
          "15",
          "bash",
          "-lc",
          registryRouteProof,
        ]),
        "HTTP/1.1 200 OK",
      );
    });

    const artifactDir = process.env.E2E_ARTIFACT_DIR;
    assert.ok(artifactDir, "E2E_ARTIFACT_DIR is required for the rootless receipt");
    fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(artifactDir, "portable-profile-rootless-receipt.json"),
      `${JSON.stringify(
        {
          sourceRevision,
          rootless: true,
          podmanPackageVersion: process.env.PODMAN_APT_VERSION ?? null,
          podmanVersion: run("podman", ["--version"]),
          podmanUrl: verifiedPodmanUrl,
          immutableNetworkRemoval: {
            networkId: disposableNetworkId,
            subnet: disposableNetworkSubnet,
            networkForce: false,
            absentAfterRemoval: true,
            retiredUpgradeEndToEnd: false,
            inspectedShape: {
              dnsEnabled: true,
              networkInterface: disposableNetworkInterface,
              networkDnsServersPresent: false,
              leaseRangePresent: false,
            },
          },
          portableNetwork: {
            id: currentNetwork.id,
            subnet: PORTABLE_DOCKER_NETWORK_SUBNET,
            hostGateway: `${PORTABLE_HOST_GATEWAY_IP}/32`,
          },
          registry: { id: currentRegistry.Id, ip: PORTABLE_REGISTRY_IP },
          hermesPortableImage: {
            imageId: hermesImageId,
            stagedContextRetired: hermesContextRetired,
          },
          authenticatedGatewayRoute: true,
          registryRoute: true,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );

    progress.phase("record portable environment completion");
    console.log("Portable profile rootless environment E2E passed.");
  } finally {
    void (disposableNetworkCreated
      ? spawnSync(
          "podman",
          [
            "--url",
            `unix://${runtimeDir}/podman/podman.sock`,
            "network",
            "rm",
            disposableNetworkId ?? disposableNetworkName,
          ],
          {
            env: process.env,
            killSignal: "SIGKILL",
            stdio: "ignore",
            timeout: 15_000,
          },
        )
      : undefined);
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
    cleanupPortableHostGatewayAlias(
      PORTABLE_HOST_GATEWAY_IP,
      gatewayAliasPresentBefore,
      process.env,
    );
    await cleanupPortableProfileRootlessFixture(runtimeDir, root);
  }
}

test(
  "portable profile rootless environment completes authenticated routes and enforces the configured Hermes dashboard Host",
  {
    meta: { e2ePhases: PORTABLE_PROFILE_E2E_PHASES },
    timeout: 900_000,
  },
  async ({ progress }) => {
    await main(progress);
  },
);
