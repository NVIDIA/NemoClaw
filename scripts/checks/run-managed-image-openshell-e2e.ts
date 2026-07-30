// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type InitialSandboxPolicy,
  prepareInitialSandboxCreatePolicy,
} from "../../src/lib/onboard/initial-policy.ts";
import { resolveCurrentManagedBootstrapRuntimeProvider } from "../../src/lib/onboard/managed-bootstrap/runtime-providers.ts";
import {
  encodeManagedStartupProfile,
  type ManagedStartupAgent,
} from "../../src/lib/onboard/managed-startup/profile.ts";
import type { SandboxCreateLaunchWithPrebuild } from "../../src/lib/onboard/sandbox-create-launch.ts";
import {
  resolveDockerStartupCommandPatch,
  runSandboxGpuCreateFlow,
} from "../../src/lib/onboard/sandbox-gpu-create-flow.ts";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "./generate-managed-startup-profile-fixture.mts";

const MANAGED_AGENTS = new Set<ManagedStartupAgent>([
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
]);
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const GATEWAY_PORT = 8080;
const IMMUTABLE_MANIFEST_REFERENCE_RE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/u;
const MANAGED_AGENT_BASE_POLICIES: Record<ManagedStartupAgent, readonly string[]> = {
  openclaw: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
  hermes: ["agents", "hermes", "policy-additions.yaml"],
  "langchain-deepagents-code": ["agents", "langchain-deepagents-code", "policy-additions.yaml"],
};

type Inputs = {
  agent: ManagedStartupAgent;
  image: string;
  sandbox: string;
};

type OnboardModule = {
  openshellArgv(args: string[]): string[];
  runOpenshell(args: string[], opts?: Record<string, unknown>): ReturnType<typeof commandResult>;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  sleepSeconds(seconds: number): void;
  startGatewayForRecovery(options: { gatewayName: string; gatewayPort: number }): Promise<void>;
};

type SandboxCreateLaunchModule = {
  prepareSandboxCreateManagedImageLaunch(
    input: Record<string, unknown>,
  ): SandboxCreateLaunchWithPrebuild;
};

function requiredValue(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

export function parseManagedImageOpenShellE2eInputs(argv: readonly string[]): Inputs {
  const unexpected = argv.filter(
    (value, index) =>
      !["--agent", "--image", "--sandbox"].includes(value) &&
      !["--agent", "--image", "--sandbox"].includes(argv[index - 1] ?? ""),
  );
  if (unexpected.length > 0) {
    throw new Error(`unsupported arguments: ${unexpected.join(" ")}`);
  }
  const agentValue = requiredValue(argv, "--agent");
  if (!MANAGED_AGENTS.has(agentValue as ManagedStartupAgent)) {
    throw new Error("--agent must identify a shipped managed-image agent");
  }
  const image = requiredValue(argv, "--image");
  if (!IMMUTABLE_MANIFEST_REFERENCE_RE.test(image)) {
    throw new Error("--image must be an immutable repository@sha256 manifest reference");
  }
  const sandbox = requiredValue(argv, "--sandbox");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/u.test(sandbox)) {
    throw new Error("--sandbox must be a valid RFC 1123 label");
  }
  return { agent: agentValue as ManagedStartupAgent, image, sandbox };
}

export function managedImageOpenShellBasePolicyPath(agent: ManagedStartupAgent): string {
  return path.resolve(__dirname, "..", "..", ...MANAGED_AGENT_BASE_POLICIES[agent]);
}

function commandResult(argv: readonly string[], env: NodeJS.ProcessEnv, timeout = 20_000) {
  const [command, ...args] = argv;
  if (!command) throw new Error("command argv must not be empty");
  return spawnSync(command, args, {
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function commandDetail(result: ReturnType<typeof commandResult>): string {
  return `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .slice(-8_000);
}

function isDockerNotFound(result: ReturnType<typeof commandResult>): boolean {
  return (
    result.status !== 0 &&
    /(?:no such (?:container|network|object)|not found)/iu.test(commandDetail(result))
  );
}

function readGatewayPid(stateDir: string): number | null {
  try {
    const value = Number.parseInt(
      fs.readFileSync(path.join(stateDir, "openshell-gateway.pid"), "utf8").trim(),
      10,
    );
    return Number.isSafeInteger(value) && value > 1 ? value : null;
  } catch {
    return null;
  }
}

function stopProcess(pid: number | null): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness probe and the final signal.
  }
}

async function assertGatewayPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      reject(
        new Error(
          `refusing to disturb an existing listener on the managed-image E2E gateway port ${GATEWAY_PORT}`,
        ),
      );
    });
    server.listen(GATEWAY_PORT, "127.0.0.1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function managedConfigPath(agent: ManagedStartupAgent): string {
  switch (agent) {
    case "openclaw":
      return "/sandbox/.openclaw/openclaw.json";
    case "hermes":
      return "/sandbox/.hermes/config.yaml";
    case "langchain-deepagents-code":
      return "/sandbox/.deepagents/config.toml";
  }
}

export function managedImageOpenShellProbe(agent: ManagedStartupAgent): string {
  const healthProbe =
    agent === "openclaw"
      ? "/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:18789/health >/dev/null"
      : agent === "hermes"
        ? "/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:8642/health >/dev/null"
        : "/usr/local/bin/dcode --version >/dev/null";
  return [
    "set -eu",
    `test -x ${
      agent === "openclaw"
        ? "/usr/local/bin/openclaw"
        : agent === "hermes"
          ? "/usr/local/bin/hermes"
          : "/usr/local/bin/dcode"
    }`,
    `grep -F ${JSON.stringify(MODEL)} ${JSON.stringify(managedConfigPath(agent))} >/dev/null`,
    "test ! -L /run/nemoclaw/managed-startup-runtime.env",
    'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-runtime.env)" = "0:0:444"',
    "test ! -L /run/nemoclaw/managed-startup-complete.json",
    'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-complete.json)" = "0:0:444"',
    "test -s /usr/local/share/nemoclaw/corporate-ca.pem",
    'test "$(stat -c "%u:%g:%a" /usr/local/share/nemoclaw/corporate-ca.pem)" = "0:0:444"',
    "test -s /run/nemoclaw/managed-startup-ca-bundle.pem",
    'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-ca-bundle.pem)" = "0:0:444"',
    healthProbe,
  ].join("\n");
}

export function managedImageOpenShellCommittedProbe(): string {
  return [
    "set -eu",
    "test ! -e /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1",
  ].join("\n");
}

async function waitForCommittedSandboxProbe(
  onboard: OnboardModule,
  input: Inputs,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const healthProbe = managedImageOpenShellProbe(input.agent);
  const committedProbe = managedImageOpenShellCommittedProbe();
  const deadline = Date.now() + 240_000;
  const runProbe = (probe: string, timeoutMs: number) =>
    commandResult(
      onboard.openshellArgv([
        "sandbox",
        "exec",
        "--name",
        input.sandbox,
        "--",
        "/bin/sh",
        "-eu",
        "-c",
        probe,
      ]),
      env,
      timeoutMs,
    );
  let lastHealthDetail = "";
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const health = runProbe(healthProbe, Math.max(1, Math.min(15_000, remainingMs)));
    if (health.status === 0) {
      const committed = runProbe(
        committedProbe,
        Math.max(1, Math.min(15_000, deadline - Date.now())),
      );
      if (committed.status !== 0) {
        throw new Error(
          `managed bootstrap committed, but transaction cleanup was not observable through the exact sandbox: ${commandDetail(committed)}`,
        );
      }
      return;
    }
    lastHealthDetail = commandDetail(health);
    const sleepMs = Math.min(2_000, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  throw new Error(
    `OpenShell sandbox did not pass the exact-image managed-bootstrap probe within 240s: ${lastHealthDetail}`,
  );
}

function parseImmutableManifestReference(image: string): {
  repository: string;
  manifestDigest: `sha256:${string}`;
} {
  const match = IMMUTABLE_MANIFEST_REFERENCE_RE.exec(image);
  if (!match?.[1] || !match[2]) {
    throw new Error("--image must be an immutable repository@sha256 manifest reference");
  }
  return {
    repository: match[1],
    manifestDigest: match[2] as `sha256:${string}`,
  };
}

function resolveLocalImageContentId(image: string, env: NodeJS.ProcessEnv): string {
  const inspect = commandResult(["docker", "image", "inspect", "--format", "{{.Id}}", image], env);
  const contentId = String(inspect.stdout ?? "").trim();
  if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(contentId)) {
    throw new Error(
      `--image does not resolve to one immutable local image content ID: ${commandDetail(inspect)}`,
    );
  }
  return contentId;
}

function exactHarnessContainerIds(
  input: Inputs,
  networkName: string,
  env: NodeJS.ProcessEnv,
): { candidateCount: number; exactIds: string[] } {
  const expectedContentId = resolveLocalImageContentId(input.image, env);
  const list = commandResult(
    [
      "docker",
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      "label=openshell.ai/managed-by=openshell",
      "--filter",
      `label=openshell.ai/sandbox-name=${input.sandbox}`,
    ],
    env,
  );
  if (list.status !== 0) {
    throw new Error(`could not resolve the OpenShell sandbox container: ${commandDetail(list)}`);
  }
  const candidates = String(list.stdout ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const exactIds: string[] = [];
  for (const candidate of candidates) {
    const inspect = commandResult(["docker", "inspect", candidate], env);
    if (inspect.status !== 0) continue;
    try {
      const records = JSON.parse(String(inspect.stdout ?? "")) as Array<{
        Config?: { Labels?: Record<string, string> };
        Image?: string;
        NetworkSettings?: { Networks?: Record<string, unknown> };
      }>;
      const record = records.length === 1 ? records[0] : undefined;
      if (
        record?.Config?.Labels?.["openshell.ai/managed-by"] === "openshell" &&
        record.Config.Labels["openshell.ai/sandbox-name"] === input.sandbox &&
        record.Image === expectedContentId &&
        Object.hasOwn(record.NetworkSettings?.Networks ?? {}, networkName)
      ) {
        exactIds.push(candidate);
      }
    } catch {
      // An unparseable inspection result cannot establish cleanup ownership.
    }
  }
  return { candidateCount: candidates.length, exactIds };
}

function assertExactSandboxImage(
  input: Inputs,
  networkName: string,
  env: NodeJS.ProcessEnv,
): string {
  const resolved = exactHarnessContainerIds(input, networkName, env);
  if (resolved.candidateCount !== 1 || resolved.exactIds.length !== 1) {
    throw new Error(
      `OpenShell did not launch exactly one harness-owned PR image container: found ${resolved.candidateCount} labeled and ${resolved.exactIds.length} exact`,
    );
  }
  return resolved.exactIds[0] ?? "";
}

async function run(input: Inputs): Promise<void> {
  const stateParent = process.env.RUNNER_TEMP || os.tmpdir();
  const stateDir = fs.mkdtempSync(path.join(stateParent, "nemoclaw-managed-openshell-"));
  const networkName = `nemoclaw-managed-pr-${process.pid}-${Date.now().toString(36)}`;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = stateDir;
  process.env.NEMOCLAW_GATEWAY_PORT = String(GATEWAY_PORT);
  process.env.NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT = "240";
  process.env.OPENSHELL_DOCKER_NETWORK_NAME = networkName;
  process.env.XDG_CONFIG_HOME = path.join(stateDir, "xdg-config");
  process.env.XDG_DATA_HOME = path.join(stateDir, "xdg-data");
  process.env.XDG_STATE_HOME = path.join(stateDir, "xdg-state");
  process.env.PATH = `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`;

  let onboard: OnboardModule | null = null;
  let ownedContainerId: string | null = null;
  let initialSandboxPolicy: InitialSandboxPolicy | null = null;
  try {
    await assertGatewayPortAvailable();
    const image = parseImmutableManifestReference(input.image);
    resolveLocalImageContentId(input.image, process.env);

    const onboardImport = (await import("../../src/lib/onboard.ts")) as unknown as
      | OnboardModule
      | { default: OnboardModule };
    onboard = "default" in onboardImport ? onboardImport.default : onboardImport;
    await onboard.startGatewayForRecovery({
      gatewayName: "nemoclaw",
      gatewayPort: GATEWAY_PORT,
    });

    const launchImport = (await import(
      "../../src/lib/onboard/sandbox-create-launch.ts"
    )) as unknown as SandboxCreateLaunchModule | { default: SandboxCreateLaunchModule };
    const launchModule = "default" in launchImport ? launchImport.default : launchImport;
    const profile = encodeManagedStartupProfile(
      managedStartupE2eProfile(input.agent, false, true, true),
    );
    initialSandboxPolicy = prepareInitialSandboxCreatePolicy(
      managedImageOpenShellBasePolicyPath(input.agent),
      [],
      { agentName: input.agent },
    );
    const createArgs = [
      "--from",
      input.image,
      "--name",
      input.sandbox,
      "--policy",
      initialSandboxPolicy.policyPath,
    ];
    const launch = launchModule.prepareSandboxCreateManagedImageLaunch({
      agent: {
        name: input.agent,
        ...(input.agent === "openclaw" ? { configPaths: { dir: "/sandbox/.openclaw" } } : {}),
      },
      sandboxName: input.sandbox,
      chatUiUrl: "",
      createArgs,
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: { config: null, enabled: false },
      manageDashboard: false,
      openshellShellCommand: (args: string[]) => args.map((arg) => JSON.stringify(arg)).join(" "),
      openshellArgv: onboard.openshellArgv,
      managedStartupProfile: {
        encodedProfile: profile,
        corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString(
          "base64",
        ),
      },
    });
    if (
      launch.prebuild.imageId !== null ||
      launch.prebuild.imageRef !== null ||
      launch.prebuild.createArgs.join("\0") !== createArgs.join("\0") ||
      launch.createArgv.filter((value) => value === "--from").length !== 1 ||
      launch.createArgv[launch.createArgv.indexOf("--from") + 1] !== input.image ||
      launch.createArgv.filter((value) => value === "--policy").length !== 1 ||
      launch.createArgv[launch.createArgv.indexOf("--policy") + 1] !==
        initialSandboxPolicy.policyPath
    ) {
      throw new Error("managed-image launch renderer altered the exact PR image identity");
    }
    const startupPlan = resolveDockerStartupCommandPatch(
      { name: input.agent } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
      true,
    );
    if (
      !launch.managedStartupRootApplyRequest ||
      !launch.managedBootstrapIdentity ||
      !launch.intendedSandboxStartupCommand
    ) {
      throw new Error("managed-image launch did not retain its identity-bound bootstrap contract");
    }

    const flow = await runSandboxGpuCreateFlow(
      {
        sandboxName: input.sandbox,
        provider: "nvidia",
        sandboxGpuConfig: {
          mode: "0",
          hostGpuDetected: false,
          hostGpuPlatform: null,
          sandboxGpuEnabled: false,
          sandboxGpuDevice: null,
          errors: [],
        },
        gpuRoutePlan: "none",
        initialGpuRoute: "none",
        compatibilityPolicyPath: null,
        dockerDriverGateway: true,
        gatewayPort: GATEWAY_PORT,
        sandboxReadyTimeoutSecs: 240,
        createArgv: launch.createArgv,
        sandboxEnv: launch.sandboxEnv,
        sandboxStartupCommand: launch.sandboxStartupCommand,
        prebuild: launch.prebuild,
        restoreBackupPath: null,
        terminalAgent: input.agent === "langchain-deepagents-code",
        managedBootstrap: {
          bootstrapIdentity: launch.managedBootstrapIdentity,
          runtimeProvider: resolveCurrentManagedBootstrapRuntimeProvider("docker"),
          request: launch.managedStartupRootApplyRequest,
          image,
          agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
          intendedWorkloadArgv: launch.intendedSandboxStartupCommand,
          expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox"],
        },
        ...startupPlan,
      },
      {
        runOpenshell: onboard.runOpenshell,
        runCaptureOpenshell: onboard.runCaptureOpenshell,
        sleep: onboard.sleepSeconds,
        openshellArgv: onboard.openshellArgv,
        verifyDirectSandboxGpu: () => ({
          status: "unverified",
          cudaVerified: false,
          label: "disabled",
          detail: null,
          at: new Date().toISOString(),
        }),
      },
    );
    if (flow.route !== "none" || flow.createResult.status !== 0) {
      throw new Error(
        `production managed-bootstrap flow did not complete the exact PR image create: route=${flow.route} status=${flow.createResult.status}`,
      );
    }

    await waitForCommittedSandboxProbe(onboard, input, launch.sandboxEnv);
    ownedContainerId = assertExactSandboxImage(input, networkName, launch.sandboxEnv);
    process.stdout.write(
      `OpenShell launched exact ${input.agent} PR image ${input.image} through the production managed-bootstrap sequence.\n`,
    );
  } finally {
    const cleanupErrors: string[] = [];
    if (onboard) {
      commandResult(
        onboard.openshellArgv(["sandbox", "delete", input.sandbox]),
        process.env,
        15_000,
      );
    }
    stopProcess(readGatewayPid(stateDir));
    if (onboard) {
      commandResult(onboard.openshellArgv(["gateway", "remove", "nemoclaw"]), process.env, 15_000);
    }
    try {
      const resolved = exactHarnessContainerIds(input, networkName, process.env);
      const cleanupContainerId =
        resolved.exactIds.length === 1 ? (resolved.exactIds[0] ?? null) : null;
      if (cleanupContainerId) {
        const remove = commandResult(
          ["docker", "rm", "-f", cleanupContainerId],
          process.env,
          15_000,
        );
        const verify = commandResult(
          ["docker", "container", "inspect", cleanupContainerId],
          process.env,
          15_000,
        );
        if (verify.status === 0 || !isDockerNotFound(verify)) {
          cleanupErrors.push(
            `exact harness container ${cleanupContainerId} was not removed: ${commandDetail(remove)} ${commandDetail(verify)}`.trim(),
          );
        }
      } else if (resolved.exactIds.length > 1) {
        cleanupErrors.push(
          `refusing ambiguous exact harness container cleanup: ${resolved.exactIds.length} matches`,
        );
      } else if (ownedContainerId) {
        const verify = commandResult(
          ["docker", "container", "inspect", ownedContainerId],
          process.env,
          15_000,
        );
        if (verify.status === 0 || !isDockerNotFound(verify)) {
          cleanupErrors.push(
            `could not prove exact harness container ${ownedContainerId} was removed: ${commandDetail(verify)}`,
          );
        }
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    const removeNetwork = commandResult(
      ["docker", "network", "rm", networkName],
      process.env,
      15_000,
    );
    const verifyNetwork = commandResult(
      ["docker", "network", "inspect", networkName],
      process.env,
      15_000,
    );
    if (verifyNetwork.status === 0 || !isDockerNotFound(verifyNetwork)) {
      cleanupErrors.push(
        `harness network ${networkName} was not removed: ${commandDetail(removeNetwork)} ${commandDetail(verifyNetwork)}`.trim(),
      );
    }
    try {
      initialSandboxPolicy?.cleanup?.();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    if (cleanupErrors.length > 0) {
      throw new Error(`managed-image OpenShell cleanup failed: ${cleanupErrors.join("; ")}`);
    }
  }
}

if (require.main === module) {
  run(parseManagedImageOpenShellE2eInputs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
