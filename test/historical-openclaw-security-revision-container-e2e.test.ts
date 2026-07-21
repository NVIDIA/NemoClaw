// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe } from "vitest";

import {
  packReviewedNpmArchive,
  removeReviewedNpmArchive,
} from "../scripts/lib/reviewed-npm-archive.mts";
import { shellQuote } from "./e2e/fixtures/clients/command.ts";
import { type DockerCommandResult, DockerProbe, resultText } from "./e2e/fixtures/docker-probe.ts";
import { expect, test } from "./e2e/fixtures/e2e-test.ts";

const TARGET_ID = "historical-openclaw-security-revision-container-e2e";
const RUN_ENV = "NEMOCLAW_RUN_HISTORICAL_OPENCLAW_SECURITY_REVISION_CONTAINER_E2E";
const IMAGE_ENV = "NEMOCLAW_HISTORICAL_OPENCLAW_SECURITY_REVISION_IMAGE";
const REVIEWED_PLUGIN_SPEC = "@openclaw/slack@2026.6.10";
const REVIEWED_PLUGIN_INTEGRITY =
  "sha512-OOsMLjPcbWhQRM5XDwfdrACjJmKqavFtpuIlhHAXWrLrd/p7SyIVE9AoKS0yxOx6bqGDIMJ9+knzdViHMLgBdA==";
const REVIEWED_PLUGIN_TARBALL = "https://registry.npmjs.org/@openclaw/slack/-/slack-2026.6.10.tgz";
const EVIDENCE_PREFIX = "NEMOCLAW_SECURITY_REVISION_EVIDENCE=";
const REPLACEMENT_ROOT = "/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0";
const CONTAINER_HOME = "/sandbox";
const OUTSIDE_STATE_ROOT = "/outside/untrusted-state";
const RUN_TIMEOUT_MS = 3 * 60_000;
const INSTALL_SUFFIX_ARGS: Readonly<Record<string, readonly string[]>> = {
  "dev-suffix": ["--dev"],
  "profile-suffix": ["--profile", "security-suffix"],
};

type InstallCase = Readonly<{
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  expectedStateRoot: string;
  id: string;
}>;

type ProbeEvidence = Readonly<{
  agentBaseVersion: string | null;
  axiosVersions: readonly string[];
  caseId: string;
  commandExitCode: number;
  credentialValue: string | null;
  credentialsIsSymbolicLink: boolean | null;
  expectedStateRoot: string;
  httpsProxyAgentVersion: string | null;
  installedAxiosVersion: string | null;
  manifestAxiosVersion: string | null;
  openClawVersion: string;
  originalInstallerInvoked: boolean | null;
  originalInstallSucceeded: boolean | null;
  pluginSpecs: readonly string[];
  rollbackArtifacts: readonly string[];
  sentinelValue: string | null;
  shrinkwrapAgentBaseVersion: string | null;
  shrinkwrapAxiosVersion: string | null;
  stateEntries: readonly string[];
}>;

const INSTALL_CASES: readonly InstallCase[] = [
  {
    id: "profile-prefix",
    args: ["--profile", "security-prefix", "plugins", "install"],
    expectedStateRoot: `${CONTAINER_HOME}/.openclaw-security-prefix`,
  },
  {
    id: "profile-suffix",
    args: ["plugins", "install"],
    expectedStateRoot: `${CONTAINER_HOME}/.openclaw-security-suffix`,
  },
  {
    id: "dev-prefix",
    args: ["--dev", "plugins", "install"],
    expectedStateRoot: `${CONTAINER_HOME}/.openclaw-dev`,
  },
  {
    id: "dev-suffix",
    args: ["plugins", "install"],
    expectedStateRoot: `${CONTAINER_HOME}/.openclaw-dev`,
  },
  {
    id: "custom-state",
    args: ["plugins", "install"],
    env: { OPENCLAW_STATE_DIR: `${CONTAINER_HOME}/custom-state` },
    expectedStateRoot: `${CONTAINER_HOME}/custom-state`,
  },
];
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS * (INSTALL_CASES.length + 2) + 10 * 60_000;

function safeDockerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function requireCondition(condition: boolean, message: string): void {
  switch (condition) {
    case true:
      return;
    default:
      throw new Error(message);
  }
}

function requireSafeImageReference(value: string): string {
  const image = value.trim();
  requireCondition(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,511}$/u.test(image),
    `${IMAGE_ENV} must be a canonical Docker image reference`,
  );
  return image;
}

function resolveConfiguredImage(env: NodeJS.ProcessEnv): string | undefined {
  const selected = env.E2E_TARGET_ID === TARGET_ID;
  const explicit = env[RUN_ENV];
  requireCondition(
    explicit === undefined || explicit === "0" || explicit === "1",
    `${RUN_ENV} must be 0 or 1`,
  );
  const enabled = selected || explicit === "1";
  const image = env[IMAGE_ENV]?.trim();
  switch (enabled) {
    case false:
      requireCondition(!image, `${IMAGE_ENV} requires ${RUN_ENV}=1`);
      return undefined;
    default:
      requireCondition(
        Boolean(image),
        `${IMAGE_ENV} is required when the container E2E is enabled`,
      );
      return requireSafeImageReference(image as string);
  }
}

function installArgs(testCase: InstallCase, archivePath: string): string[] {
  const args = [...testCase.args];
  const installIndex = args.indexOf("install");
  requireCondition(installIndex >= 0, `install case ${testCase.id} has no install command`);
  args.splice(installIndex + 1, 0, archivePath);
  args.push(...(INSTALL_SUFFIX_ARGS[testCase.id] ?? []));
  return args;
}

const PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");

const stateRoot = process.env.NEMOCLAW_E2E_STATE_ROOT;
if (!stateRoot) throw new Error("NEMOCLAW_E2E_STATE_ROOT is required");
const credentialPath = process.env.NEMOCLAW_E2E_CREDENTIAL_PATH;
const sentinelPath = process.env.NEMOCLAW_E2E_SENTINEL_PATH;
const packages = [];
let visited = 0;

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (++visited > 50000) throw new Error("state tree exceeded verifier entry bound");
    const child = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(child);
      continue;
    }
    if (!entry.isFile() || entry.name !== "package.json") continue;
    const manifest = JSON.parse(fs.readFileSync(child, "utf8"));
    packages.push({ manifest, root: path.dirname(child) });
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readText(file) {
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

function isSymbolicLink(file) {
  if (!file) return null;
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return null;
  }
}

walk(stateRoot);
const plugins = packages.filter(({ manifest }) => manifest.name === "@openclaw/slack");
const livePlugin = plugins.length === 1 ? plugins[0] : undefined;
const pluginRoot = livePlugin?.root;
const pluginManifest = livePlugin?.manifest;
const shrinkwrap = pluginRoot ? readJson(path.join(pluginRoot, "npm-shrinkwrap.json")) : undefined;
const axiosRoot = pluginRoot ? path.join(pluginRoot, "node_modules", "axios") : undefined;
const installedAxios = axiosRoot ? readJson(path.join(axiosRoot, "package.json")) : undefined;
const proxyRoot = axiosRoot ? path.join(axiosRoot, "node_modules", "https-proxy-agent") : undefined;
const proxyManifest = proxyRoot ? readJson(path.join(proxyRoot, "package.json")) : undefined;
const agentBaseRoot = proxyRoot ? path.join(proxyRoot, "node_modules", "agent-base") : undefined;
const agentBaseManifest = agentBaseRoot ? readJson(path.join(agentBaseRoot, "package.json")) : undefined;
const evidence = {
  agentBaseVersion: agentBaseManifest?.version ?? null,
  axiosVersions: packages
    .filter(({ manifest }) => manifest.name === "axios")
    .map(({ manifest }) => String(manifest.version))
    .sort(),
  caseId: process.env.NEMOCLAW_E2E_CASE_ID,
  commandExitCode: Number(process.env.NEMOCLAW_E2E_COMMAND_EXIT),
  credentialValue: readText(credentialPath),
  credentialsIsSymbolicLink: isSymbolicLink(credentialPath ? path.dirname(credentialPath) : undefined),
  expectedStateRoot: stateRoot,
  httpsProxyAgentVersion: proxyManifest?.version ?? null,
  installedAxiosVersion: installedAxios?.version ?? null,
  manifestAxiosVersion: pluginManifest?.dependencies?.axios ?? null,
  openClawVersion: process.env.NEMOCLAW_E2E_OPENCLAW_VERSION ?? "",
  originalInstallerInvoked: process.env.NEMOCLAW_E2E_ORIGINAL_INVOCATION_MARKER
    ? fs.existsSync(process.env.NEMOCLAW_E2E_ORIGINAL_INVOCATION_MARKER)
    : null,
  originalInstallSucceeded: process.env.NEMOCLAW_E2E_ORIGINAL_SUCCESS_MARKER
    ? fs.existsSync(process.env.NEMOCLAW_E2E_ORIGINAL_SUCCESS_MARKER)
    : null,
  pluginSpecs: plugins.map(({ manifest }) => String(manifest.name) + "@" + String(manifest.version)).sort(),
  rollbackArtifacts: fs.existsSync(path.dirname(stateRoot))
    ? fs.readdirSync(path.dirname(stateRoot)).filter((name) => name.startsWith(".nemoclaw-openclaw-"))
    : [],
  sentinelValue: readText(sentinelPath),
  shrinkwrapAgentBaseVersion:
    shrinkwrap?.packages?.["node_modules/axios/node_modules/https-proxy-agent/node_modules/agent-base"]?.version ?? null,
  shrinkwrapAxiosVersion: shrinkwrap?.packages?.["node_modules/axios"]?.version ?? null,
  stateEntries: fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).sort() : [],
};
process.stdout.write(${JSON.stringify(EVIDENCE_PREFIX)} + JSON.stringify(evidence) + "\n");
`;

const ORIGINAL_SUCCESS_MARKER_SOURCE = String.raw`
const fs = require("node:fs");
const entrypoint = process.argv[1];
const invocationMarker = process.env.NEMOCLAW_E2E_ORIGINAL_INVOCATION_MARKER;
const marker = process.env.NEMOCLAW_E2E_ORIGINAL_SUCCESS_MARKER;
if (entrypoint && (invocationMarker || marker)) {
  let resolved = entrypoint;
  try {
    resolved = fs.realpathSync(entrypoint);
  } catch {}
  if (resolved === "/usr/local/lib/node_modules/openclaw/openclaw.mjs") {
    if (invocationMarker) fs.writeFileSync(invocationMarker, "invoked\n", { mode: 0o600 });
    if (marker) {
      process.once("exit", (code) => {
        if (code === 0) fs.writeFileSync(marker, "ok\n", { mode: 0o600 });
      });
    }
  }
}
`;

function probeScript(testCase: InstallCase, archivePath: string, setup = ""): string {
  const env = Object.entries(testCase.env ?? {})
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
    .join("\n");
  const command = ["/usr/local/bin/openclaw", ...installArgs(testCase, archivePath)]
    .map(shellQuote)
    .join(" ");
  return `set -uo pipefail
umask 077
export HOME=${shellQuote(CONTAINER_HOME)}
export npm_config_cache=${shellQuote(`${CONTAINER_HOME}/.npm-cache`)}
export npm_config_fetch_retries=1
export npm_config_fetch_retry_maxtimeout=15000
export npm_config_fetch_timeout=15000
export npm_config_ignore_scripts=true
${env}
${setup}
set +e
${command}
status=$?
set -e
unset NODE_OPTIONS
export NEMOCLAW_E2E_CASE_ID=${shellQuote(testCase.id)}
export NEMOCLAW_E2E_COMMAND_EXIT="$status"
export NEMOCLAW_E2E_STATE_ROOT=${shellQuote(testCase.expectedStateRoot)}
export NEMOCLAW_E2E_OPENCLAW_VERSION="$(/usr/local/bin/openclaw --version 2>/dev/null || true)"
node -e ${shellQuote(PROBE_SOURCE)}`;
}

function secureDockerRunArgs(options: {
  container: string;
  fixtureVolume: string;
  image: string;
  script: string;
  volume: string;
  hideReplacement?: boolean;
  outsideState?: boolean;
}): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    options.container,
    "--user",
    "sandbox:sandbox",
    "--read-only",
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--cpus",
    "2",
    "--ulimit",
    "nofile=1024:1024",
    "--mount",
    `type=volume,source=${options.volume},target=${CONTAINER_HOME}`,
    "--mount",
    `type=volume,source=${options.fixtureVolume},target=/fixture,readonly`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
  ];
  args.push(
    ...(options.hideReplacement
      ? ["--mount", `type=tmpfs,target=${REPLACEMENT_ROOT},tmpfs-size=1048576,tmpfs-mode=0555`]
      : []),
    ...(options.outsideState ? ["--tmpfs", "/outside:rw,nosuid,nodev,size=64m,mode=1777"] : []),
  );
  args.push("--entrypoint", "bash", options.image, "-lc", options.script);
  return args;
}

function parseEvidence(result: DockerCommandResult): ProbeEvidence {
  requireCondition(result.exitCode === 0, resultText(result));
  const line = result.stdout
    .split(/\r?\n/gu)
    .reverse()
    .find((candidate) => candidate.startsWith(EVIDENCE_PREFIX));
  requireCondition(
    Boolean(line),
    `container did not emit security revision evidence\n${resultText(result)}`,
  );
  return JSON.parse((line as string).slice(EVIDENCE_PREFIX.length)) as ProbeEvidence;
}

function requireSuccessfulRemediation(testCase: InstallCase, evidence: ProbeEvidence): void {
  expect(evidence.caseId).toBe(testCase.id);
  expect(evidence.commandExitCode).toBe(0);
  expect(evidence.expectedStateRoot).toBe(testCase.expectedStateRoot);
  expect(evidence.openClawVersion).toContain("2026.6.10");
  expect(evidence.pluginSpecs).toEqual([REVIEWED_PLUGIN_SPEC]);
  expect(evidence.installedAxiosVersion).toBe("1.18.0");
  expect(evidence.manifestAxiosVersion).toBe("1.18.0");
  expect(evidence.shrinkwrapAxiosVersion).toBe("1.18.0");
  expect(evidence.httpsProxyAgentVersion).toBe("5.0.1");
  expect(evidence.agentBaseVersion).toBe("6.0.2");
  expect(evidence.shrinkwrapAgentBaseVersion).toBe("6.0.2");
  expect(evidence.axiosVersions).toContain("1.18.0");
  expect(evidence.axiosVersions).not.toContain("1.16.0");
}

function exactPluginEvidence(testCase = INSTALL_CASES[0]): ProbeEvidence {
  return {
    agentBaseVersion: "6.0.2",
    axiosVersions: ["1.18.0"],
    caseId: testCase.id,
    commandExitCode: 0,
    credentialValue: null,
    credentialsIsSymbolicLink: null,
    expectedStateRoot: testCase.expectedStateRoot,
    httpsProxyAgentVersion: "5.0.1",
    installedAxiosVersion: "1.18.0",
    manifestAxiosVersion: "1.18.0",
    openClawVersion: "OpenClaw 2026.6.10",
    originalInstallerInvoked: null,
    originalInstallSucceeded: null,
    pluginSpecs: [REVIEWED_PLUGIN_SPEC],
    rollbackArtifacts: [],
    sentinelValue: null,
    shrinkwrapAgentBaseVersion: "6.0.2",
    shrinkwrapAxiosVersion: "1.18.0",
    stateEntries: [],
  };
}

function requireFailedInstallRestored(evidence: ProbeEvidence): void {
  expect(evidence.commandExitCode).not.toBe(0);
  expect(evidence.originalInstallerInvoked).toBe(true);
  expect(evidence.originalInstallSucceeded).toBe(true);
  expect(evidence.pluginSpecs).toEqual([]);
  expect(evidence.axiosVersions).not.toContain("1.16.0");
  expect(evidence.stateEntries).toEqual(["credentials", "sentinel.txt"]);
  expect(evidence.sentinelValue).toBe("prior-state\n");
  expect(evidence.credentialValue).toBe("prior-credential\n");
  expect(evidence.credentialsIsSymbolicLink).toBe(false);
  expect(evidence.rollbackArtifacts).toEqual([]);
}

function requireOutsideHomeRejected(evidence: ProbeEvidence): void {
  expect(evidence.commandExitCode).toBe(64);
  expect(evidence.originalInstallerInvoked).toBe(false);
  expect(evidence.originalInstallSucceeded).toBe(false);
  expect(evidence.pluginSpecs).toEqual([]);
  expect(evidence.stateEntries).toEqual(["sentinel.txt"]);
  expect(evidence.sentinelValue).toBe("outside-state\n");
  expect(evidence.rollbackArtifacts).toEqual([]);
}

const configuredImage = resolveConfiguredImage(process.env);
const realContainerTest = configuredImage ? test : test.skip;

describe("Historical OpenClaw security revision container E2E contract (#7272)", () => {
  test("keeps real Docker execution explicitly opt-in until the revision image lands", () => {
    expect(resolveConfiguredImage({})).toBeUndefined();
    expect(() => resolveConfiguredImage({ [RUN_ENV]: "1" })).toThrow(IMAGE_ENV);
    expect(() => resolveConfiguredImage({ [IMAGE_ENV]: "candidate:local" })).toThrow(RUN_ENV);
  });

  test("covers every supported OpenClaw state selector without shell-derived inputs", () => {
    expect(INSTALL_CASES.map(({ id }) => id)).toEqual([
      "profile-prefix",
      "profile-suffix",
      "dev-prefix",
      "dev-suffix",
      "custom-state",
    ]);
    for (const testCase of INSTALL_CASES) {
      expect(installArgs(testCase, "/fixture/plugin.tgz")).toContain("/fixture/plugin.tgz");
      expect(testCase.expectedStateRoot.startsWith(CONTAINER_HOME)).toBe(true);
    }
  });

  test("builds a bounded least-privilege Docker boundary without host networking", () => {
    const args = secureDockerRunArgs({
      container: "security-e2e",
      fixtureVolume: "security-e2e-fixture",
      image: "candidate:local",
      script: "true",
      volume: "security-e2e-state",
    });
    for (const [option, value] of [
      ["--user", "sandbox:sandbox"],
      ["--network", "bridge"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
    ] as const) {
      const optionIndex = args.indexOf(option);
      expect(args.slice(optionIndex, optionIndex + 2)).toEqual([option, value]);
    }
    expect(args).not.toContain("host");
    expect(args).toContain("--read-only");
    expect(args.join(" ")).not.toContain("docker.sock");
    const mounts = args.flatMap((value, index) => (value === "--mount" ? [args[index + 1]] : []));
    expect(mounts.every((mount) => mount?.startsWith("type=volume,source="))).toBe(true);
  });

  test("models rejection of an OpenClaw state directory outside the container home", () => {
    const args = secureDockerRunArgs({
      container: "security-e2e",
      fixtureVolume: "security-e2e-fixture",
      image: "candidate:local",
      outsideState: true,
      script: "true",
      volume: "security-e2e-state",
    });
    const outsideIndex = args.indexOf("/outside:rw,nosuid,nodev,size=64m,mode=1777");
    expect(args.slice(outsideIndex - 1, outsideIndex + 1)).toEqual([
      "--tmpfs",
      "/outside:rw,nosuid,nodev,size=64m,mode=1777",
    ]);
  });

  test("rejects vulnerable or inconsistent remediation evidence", () => {
    const testCase = INSTALL_CASES[0];
    const good = exactPluginEvidence(testCase);
    expect(() => requireSuccessfulRemediation(testCase, good)).not.toThrow();
    expect(() =>
      requireSuccessfulRemediation(testCase, {
        ...good,
        axiosVersions: ["1.16.0"],
      }),
    ).toThrow();
    expect(() =>
      requireSuccessfulRemediation(testCase, {
        ...good,
        shrinkwrapAxiosVersion: "1.16.0",
      }),
    ).toThrow();
  });

  test("rejects failure evidence that loses prior state or protected credentials", () => {
    const restored: ProbeEvidence = {
      ...exactPluginEvidence(),
      axiosVersions: [],
      commandExitCode: 70,
      credentialValue: "prior-credential\n",
      credentialsIsSymbolicLink: false,
      originalInstallerInvoked: true,
      originalInstallSucceeded: true,
      pluginSpecs: [],
      sentinelValue: "prior-state\n",
      stateEntries: ["credentials", "sentinel.txt"],
    };
    expect(() => requireFailedInstallRestored(restored)).not.toThrow();
    expect(() =>
      requireFailedInstallRestored({
        ...restored,
        credentialValue: null,
      }),
    ).toThrow();
  });

  test("requires outside-home state rejection before the original installer runs", () => {
    const rejected: ProbeEvidence = {
      ...exactPluginEvidence(),
      axiosVersions: [],
      caseId: "outside-home-state",
      commandExitCode: 64,
      expectedStateRoot: OUTSIDE_STATE_ROOT,
      originalInstallerInvoked: false,
      originalInstallSucceeded: false,
      pluginSpecs: [],
      sentinelValue: "outside-state\n",
      stateEntries: ["sentinel.txt"],
    };
    expect(() => requireOutsideHomeRejected(rejected)).not.toThrow();
    expect(() =>
      requireOutsideHomeRejected({
        ...rejected,
        originalInstallerInvoked: true,
      }),
    ).toThrow();
  });
});

realContainerTest(
  "the historical wrapper remediates reviewed plugins, restores failures, and rejects outside state (#7272)",
  async ({ artifacts, cleanup, docker, secrets }) => {
    const image = configuredImage as string;
    const probe = new DockerProbe(artifacts, (text, extraValues) =>
      secrets.redact(text, extraValues),
    );
    const resourcePrefix = safeDockerName(`nemoclaw-security-e2e-${process.pid}-${randomUUID()}`);
    const containers: string[] = [];
    const volumes: string[] = [];
    const npmHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-security-e2e-npm-"));
    cleanup.add("remove reviewed plugin archive", () =>
      fs.rmSync(npmHome, { recursive: true, force: true }),
    );
    cleanup.add("remove security revision containers and volumes", async () => {
      for (const container of containers) {
        const result = await probe.run(["rm", "-f", container], {
          artifactName: `cleanup-${container}`,
          timeoutMs: 30_000,
        });
        requireCondition(
          result.exitCode === 0 || result.stderr.includes("No such container"),
          resultText(result),
        );
      }
      for (const volume of volumes) {
        await probe.expect(["volume", "rm", "-f", volume], {
          artifactName: `cleanup-${volume}`,
          timeoutMs: 30_000,
        });
      }
    });

    await docker.requireDocker();
    const imageInspection = await probe.expect(["image", "inspect", "--format", "{{.Id}}", image], {
      artifactName: "inspect-security-revision-image",
      timeoutMs: 30_000,
    });
    const imageId = imageInspection.stdout.trim();
    requireCondition(
      /^sha256:[0-9a-f]{64}$/u.test(imageId),
      `candidate image did not resolve to an immutable image ID: ${imageId}`,
    );
    await artifacts.writeJson("evidence/image-identity.json", {
      configuredImage: image,
      imageId,
    });
    await artifacts.target.declare({
      id: TARGET_ID,
      boundary: "historical-openclaw-image-wrapper",
      image: imageId,
      contracts: [
        "effective OpenClaw state selectors receive reviewed plugin remediation",
        "post-install remediation failure restores prior state and credentials",
        "state directories outside HOME are rejected before the original installer runs",
      ],
    });

    const reviewedArchive = packReviewedNpmArchive({
      env: {
        HOME: npmHome,
        PATH: process.env.PATH,
        npm_config_audit: "false",
        npm_config_cache: path.join(npmHome, "cache"),
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_userconfig: "/dev/null",
      },
      expectedIntegrity: REVIEWED_PLUGIN_INTEGRITY,
      label: "OpenClaw security revision E2E fixture",
      packageSpec: REVIEWED_PLUGIN_SPEC,
      tarballUrl: REVIEWED_PLUGIN_TARBALL,
      tempDirectory: npmHome,
    });
    cleanup.add("remove packed reviewed plugin", () => removeReviewedNpmArchive(reviewedArchive));
    const fixtureVolume = `${resourcePrefix}-fixture`;
    const fixtureLoader = `${resourcePrefix}-fixture-loader`;
    const archiveInContainer = "/fixture/reviewed-plugin.tgz";
    const markerSource = path.join(npmHome, "original-success-marker.cjs");
    fs.writeFileSync(markerSource, ORIGINAL_SUCCESS_MARKER_SOURCE, { mode: 0o444 });
    fs.chmodSync(reviewedArchive.archivePath, 0o444);
    volumes.push(fixtureVolume);
    containers.push(fixtureLoader);
    await probe.expect(["volume", "create", fixtureVolume], {
      artifactName: "create-fixture-volume",
    });
    await probe.expect(
      [
        "run",
        "-d",
        "--name",
        fixtureLoader,
        "--user",
        "sandbox:sandbox",
        "--read-only",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "1",
        "--ulimit",
        "nofile=256:256",
        "--mount",
        `type=volume,source=${fixtureVolume},target=/fixture`,
        "--entrypoint",
        "bash",
        imageId,
        "-lc",
        "sleep 300",
      ],
      { artifactName: "start-fixture-loader", timeoutMs: 30_000 },
    );
    await probe.expect(
      ["cp", reviewedArchive.archivePath, `${fixtureLoader}:${archiveInContainer}`],
      {
        artifactName: "copy-reviewed-plugin-fixture",
        timeoutMs: 30_000,
      },
    );
    await probe.expect(
      ["cp", markerSource, `${fixtureLoader}:/fixture/original-success-marker.cjs`],
      {
        artifactName: "copy-original-success-marker",
        timeoutMs: 30_000,
      },
    );
    await probe.expect(["rm", "-f", fixtureLoader], {
      artifactName: "stop-fixture-loader",
      timeoutMs: 30_000,
    });
    containers.splice(containers.indexOf(fixtureLoader), 1);

    for (const testCase of INSTALL_CASES) {
      const volume = `${resourcePrefix}-${testCase.id}`;
      const container = `${resourcePrefix}-${testCase.id}`;
      volumes.push(volume);
      containers.push(container);
      await probe.expect(["volume", "create", volume], {
        artifactName: `create-${testCase.id}-state-volume`,
      });
      const result = await probe.run(
        secureDockerRunArgs({
          container,
          fixtureVolume,
          image: imageId,
          script: probeScript(testCase, archiveInContainer),
          volume,
        }),
        { artifactName: `install-${testCase.id}`, timeoutMs: RUN_TIMEOUT_MS },
      );
      const evidence = parseEvidence(result);
      requireSuccessfulRemediation(testCase, evidence);
      await artifacts.writeJson(`evidence/${testCase.id}.json`, evidence);
    }

    const failureCase: InstallCase = {
      id: "post-install-remediation-failure",
      args: ["plugins", "install"],
      env: {
        NEMOCLAW_E2E_CREDENTIAL_PATH: `${CONTAINER_HOME}/.openclaw/credentials/token`,
        NEMOCLAW_E2E_ORIGINAL_INVOCATION_MARKER: `${CONTAINER_HOME}/.original-installer-invoked`,
        NEMOCLAW_E2E_ORIGINAL_SUCCESS_MARKER: `${CONTAINER_HOME}/.original-install-succeeded`,
        NEMOCLAW_E2E_SENTINEL_PATH: `${CONTAINER_HOME}/.openclaw/sentinel.txt`,
        NODE_OPTIONS: "--require=/fixture/original-success-marker.cjs",
      },
      expectedStateRoot: `${CONTAINER_HOME}/.openclaw`,
    };
    const failureVolume = `${resourcePrefix}-failure`;
    const failureContainer = `${resourcePrefix}-failure`;
    volumes.push(failureVolume);
    containers.push(failureContainer);
    await probe.expect(["volume", "create", failureVolume], {
      artifactName: "create-failure-state-volume",
    });
    const failureSetup = [
      `mkdir -p ${shellQuote(`${CONTAINER_HOME}/.openclaw/credentials`)}`,
      `printf 'prior-state\\n' > ${shellQuote(`${CONTAINER_HOME}/.openclaw/sentinel.txt`)}`,
      `printf 'prior-credential\\n' > ${shellQuote(`${CONTAINER_HOME}/.openclaw/credentials/token`)}`,
    ].join("\n");
    const failureResult = await probe.run(
      secureDockerRunArgs({
        container: failureContainer,
        fixtureVolume,
        hideReplacement: true,
        image: imageId,
        script: probeScript(failureCase, archiveInContainer, failureSetup),
        volume: failureVolume,
      }),
      { artifactName: "post-install-remediation-failure", timeoutMs: RUN_TIMEOUT_MS },
    );
    const failureEvidence = parseEvidence(failureResult);
    requireFailedInstallRestored(failureEvidence);
    await artifacts.writeJson("evidence/post-install-remediation-failure.json", failureEvidence);

    const outsideCase: InstallCase = {
      id: "outside-home-state",
      args: ["plugins", "install"],
      env: {
        NEMOCLAW_E2E_ORIGINAL_INVOCATION_MARKER: `${CONTAINER_HOME}/.outside-original-installer-invoked`,
        NEMOCLAW_E2E_ORIGINAL_SUCCESS_MARKER: `${CONTAINER_HOME}/.outside-original-install-succeeded`,
        NEMOCLAW_E2E_SENTINEL_PATH: `${OUTSIDE_STATE_ROOT}/sentinel.txt`,
        NODE_OPTIONS: "--require=/fixture/original-success-marker.cjs",
        OPENCLAW_STATE_DIR: OUTSIDE_STATE_ROOT,
      },
      expectedStateRoot: OUTSIDE_STATE_ROOT,
    };
    const outsideVolume = `${resourcePrefix}-outside-home`;
    const outsideContainer = `${resourcePrefix}-outside-home`;
    volumes.push(outsideVolume);
    containers.push(outsideContainer);
    await probe.expect(["volume", "create", outsideVolume], {
      artifactName: "create-outside-home-state-volume",
    });
    const outsideSetup = [
      `mkdir -p ${shellQuote(OUTSIDE_STATE_ROOT)}`,
      `printf 'outside-state\\n' > ${shellQuote(`${OUTSIDE_STATE_ROOT}/sentinel.txt`)}`,
    ].join("\n");
    const outsideResult = await probe.run(
      secureDockerRunArgs({
        container: outsideContainer,
        fixtureVolume,
        image: imageId,
        outsideState: true,
        script: probeScript(outsideCase, archiveInContainer, outsideSetup),
        volume: outsideVolume,
      }),
      { artifactName: "reject-outside-home-state", timeoutMs: RUN_TIMEOUT_MS },
    );
    const outsideEvidence = parseEvidence(outsideResult);
    expect(outsideResult.stderr).toContain(
      `OpenClaw state directory must be a direct child of ${CONTAINER_HOME}`,
    );
    requireOutsideHomeRejected(outsideEvidence);
    await artifacts.writeJson("evidence/outside-home-state.json", outsideEvidence);

    await artifacts.target.complete({
      id: TARGET_ID,
      image: imageId,
      assertions: {
        failClosedRestoration: true,
        outsideHomeStateRejected: true,
        stateSelectors: INSTALL_CASES.map(({ id }) => id),
      },
    });
  },
  TEST_TIMEOUT_MS,
);
