// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "../adapters/docker/exec";
import {
  buildCoreDnsPatchJson,
  dockerHostRuntime,
  isSafeDnsUpstream,
  resolveCoreDnsUpstream,
  selectOpenshellClusterContainer,
  type ContainerRuntime,
} from "../domain/dns/coredns";
import {
  buildDnsProxyPython,
  buildDnsReadyProbePython,
  buildResolvConf,
  DEFAULT_DNS_UPSTREAM,
  isSafeDnsAddress,
  parseVethGateway,
  selectSandboxNamespace,
  selectSandboxPod,
} from "../domain/dns/setup-proxy";

export type CommandResult = Pick<SpawnSyncReturns<string>, "stderr" | "stdout" | "status">;

export interface FixCoreDnsDeps {
  commandExists?: (command: string) => boolean;
  env?: NodeJS.ProcessEnv;
  existsSocket?: (socketPath: string) => boolean;
  log?: (message: string) => void;
  platform?: NodeJS.Platform;
  readFile?: (filePath: string) => string;
  run?: (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult;
  runDocker?: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult;
  uid?: () => string;
}

export interface FixCoreDnsOptions {
  gatewayName?: string;
}

export interface SetupDnsProxyOptions {
  gatewayName: string;
  sandboxName: string;
}

export interface SetupDnsProxyDeps extends FixCoreDnsDeps {
  sleep?: (ms: number) => void;
}

export interface SetupDnsProxyResult {
  cluster?: string;
  dnsUpstream?: string;
  exitCode: number;
  message?: string;
  pod?: string;
  sandboxNamespace?: string;
  verificationFail?: number;
  verificationPass?: number;
  vethGateway?: string;
}

export interface FixCoreDnsResult {
  cluster?: string;
  exitCode: number;
  message?: string;
  runtime?: ContainerRuntime;
  skipped?: boolean;
  upstreamDns?: string;
}

function defaultRun(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  return spawnSync(command, args, {
    encoding: "utf-8",
    env: options.env,
  });
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
  return result.status === 0;
}

function socketExists(socketPath: string, env: NodeJS.ProcessEnv): boolean {
  const testSocketPaths = env.NEMOCLAW_TEST_SOCKET_PATHS;
  if (testSocketPaths) return testSocketPaths.split(path.delimiter).includes(socketPath);
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function findFirstSocket(candidates: string[], deps: Required<Pick<FixCoreDnsDeps, "existsSocket">>): string | null {
  return candidates.find((candidate) => deps.existsSocket(candidate)) ?? null;
}

function detectDockerHost(env: NodeJS.ProcessEnv, deps: FixCoreDnsDeps): { dockerHost?: string; runtime: ContainerRuntime } {
  if (env.DOCKER_HOST) return { dockerHost: env.DOCKER_HOST, runtime: dockerHostRuntime(env.DOCKER_HOST) ?? "custom" };

  const home = env.HOME || os.tmpdir();
  const existsSocket = deps.existsSocket ?? ((socketPath: string) => socketExists(socketPath, env));
  const colimaSocket = findFirstSocket(
    [path.join(home, ".colima/default/docker.sock"), path.join(home, ".config/colima/default/docker.sock")],
    { existsSocket },
  );
  if (colimaSocket) return { dockerHost: `unix://${colimaSocket}`, runtime: "colima" };

  const podmanCandidates =
    (deps.platform ?? process.platform) === "darwin"
      ? [path.join(home, ".local/share/containers/podman/machine/podman.sock"), "/var/run/docker.sock"]
      : [
          path.join(env.XDG_RUNTIME_DIR || `/run/user/${deps.uid?.() ?? "1000"}`, "podman/podman.sock"),
          `/run/user/${deps.uid?.() ?? "1000"}/podman/podman.sock`,
          "/run/podman/podman.sock",
        ];
  const podmanSocket = findFirstSocket(podmanCandidates, { existsSocket });
  if (podmanSocket) return { dockerHost: `unix://${podmanSocket}`, runtime: "podman" };

  return { runtime: "unknown" };
}

function commandOutput(result: CommandResult): string {
  return result.status === 0 ? result.stdout : "";
}

function defaultRunDocker(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): CommandResult {
  const result = dockerSpawnSync(args, { encoding: "utf-8", env: options.env });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
    stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function kctl(
  runDocker: (args: string[], options?: { env?: NodeJS.ProcessEnv }) => CommandResult,
  cluster: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): CommandResult {
  if (args[0] === "exec") {
    return runDocker(["exec", cluster, "kubectl", "exec", "-c", "agent", ...args.slice(1)], { env });
  }
  return runDocker(["exec", cluster, "kubectl", ...args], { env });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getColimaVmResolvConf(deps: FixCoreDnsDeps, env: NodeJS.ProcessEnv): string {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  if (!commandExists("colima")) return "";
  const run = deps.run ?? defaultRun;
  return commandOutput(
    run("colima", ["ssh", "--profile", env.COLIMA_PROFILE || "default", "--", "cat", "/etc/resolv.conf"], {
      env,
    }),
  );
}

export function runFixCoreDns(
  options: FixCoreDnsOptions = {},
  deps: FixCoreDnsDeps = {},
): FixCoreDnsResult {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const log = deps.log ?? console.log;
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const detected = detectDockerHost(env, deps);

  if (!detected.dockerHost || (detected.runtime !== "colima" && detected.runtime !== "podman")) {
    log("Skipping CoreDNS patch: no supported Colima or Podman Docker socket found.");
    return { exitCode: 0, runtime: detected.runtime, skipped: true };
  }

  const dockerEnv = { ...env, DOCKER_HOST: detected.dockerHost };
  const clustersOutput = commandOutput(
    runDocker(["ps", "--filter", "name=openshell-cluster", "--format", "{{.Names}}"], {
      env: dockerEnv,
    }),
  );
  const cluster = selectOpenshellClusterContainer(options.gatewayName, clustersOutput);
  if (!cluster) {
    const target = options.gatewayName ? ` for gateway '${options.gatewayName}'` : "";
    return {
      exitCode: 1,
      message: `ERROR: Could not uniquely determine the openshell cluster container${target}.`,
      runtime: detected.runtime,
    };
  }

  const containerResolvConf = commandOutput(
    runDocker(["exec", cluster, "cat", "/etc/resolv.conf"], { env: dockerEnv }),
  );
  const hostResolvConf = readFile("/etc/resolv.conf");
  const colimaVmResolvConf = detected.runtime === "colima" ? getColimaVmResolvConf(deps, dockerEnv) : undefined;
  const upstreamDns = resolveCoreDnsUpstream({
    colimaVmResolvConf,
    containerResolvConf,
    hostResolvConf,
    runtime: detected.runtime,
  });

  if (!upstreamDns) {
    return {
      cluster,
      exitCode: 1,
      message: `ERROR: Could not determine a non-loopback DNS upstream for ${detected.runtime}.`,
      runtime: detected.runtime,
    };
  }

  if (!isSafeDnsUpstream(upstreamDns)) {
    return {
      cluster,
      exitCode: 1,
      message: `ERROR: UPSTREAM_DNS='${upstreamDns}' contains invalid characters. Aborting.`,
      runtime: detected.runtime,
      upstreamDns,
    };
  }

  log(`Patching CoreDNS to forward to ${upstreamDns}...`);
  const patchJson = buildCoreDnsPatchJson(upstreamDns);
  for (const args of [
    ["exec", cluster, "kubectl", "patch", "configmap", "coredns", "-n", "kube-system", "--type", "merge", "-p", patchJson],
    ["exec", cluster, "kubectl", "rollout", "restart", "deploy/coredns", "-n", "kube-system"],
  ]) {
    const result = runDocker(args, { env: dockerEnv });
    if (result.status !== 0) {
      return { cluster, exitCode: result.status ?? 1, message: result.stderr.trim(), runtime: detected.runtime, upstreamDns };
    }
  }

  log("CoreDNS patched. Waiting for rollout...");
  const rollout = runDocker(
    ["exec", cluster, "kubectl", "rollout", "status", "deploy/coredns", "-n", "kube-system", "--timeout=30s"],
    { env: dockerEnv },
  );
  if (rollout.status !== 0) {
    return { cluster, exitCode: rollout.status ?? 1, message: rollout.stderr.trim(), runtime: detected.runtime, upstreamDns };
  }

  log("Done. DNS should resolve in ~10 seconds.");
  return { cluster, exitCode: 0, runtime: detected.runtime, upstreamDns };
}

export function runSetupDnsProxy(
  options: SetupDnsProxyOptions,
  deps: SetupDnsProxyDeps = {},
): SetupDnsProxyResult {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const log = deps.log ?? console.log;
  const runDocker = deps.runDocker ?? defaultRunDocker;
  const sleep = deps.sleep ?? sleepSync;
  const detected = detectDockerHost(env, deps);
  const dockerEnv = detected.dockerHost ? { ...env, DOCKER_HOST: detected.dockerHost } : env;

  const clustersOutput = commandOutput(
    runDocker(["ps", "--filter", "name=openshell-cluster", "--format", "{{.Names}}"], {
      env: dockerEnv,
    }),
  );
  const cluster = selectOpenshellClusterContainer(options.gatewayName, clustersOutput);
  if (!cluster) {
    const message = options.gatewayName
      ? `WARNING: Could not find gateway container for '${options.gatewayName}'. DNS proxy not installed.`
      : "WARNING: Could not find any openshell cluster container. DNS proxy not installed.";
    log(message);
    return { exitCode: 1, message };
  }

  let dnsUpstream = commandOutput(
    kctl(
      runDocker,
      cluster,
      ["get", "endpoints", "kube-dns", "-n", "kube-system", "-o", "jsonpath={.subsets[0].addresses[0].ip}"],
      dockerEnv,
    ),
  ).trim();
  if (!dnsUpstream) {
    log("WARNING: Could not discover CoreDNS pod IP. Falling back to 8.8.8.8.");
    log("WARNING: k8s-internal names (inference.local routing) will NOT work.");
    dnsUpstream = DEFAULT_DNS_UPSTREAM;
  }
  if (!isSafeDnsAddress(dnsUpstream)) {
    return { cluster, dnsUpstream, exitCode: 1, message: `ERROR: DNS upstream '${dnsUpstream}' contains invalid characters.` };
  }

  const podsOutput = commandOutput(kctl(runDocker, cluster, ["get", "pods", "-n", "openshell", "-o", "name"], dockerEnv));
  const pod = selectSandboxPod(options.sandboxName, podsOutput);
  if (!pod) {
    const message = `WARNING: Could not find pod for sandbox '${options.sandboxName}'. DNS proxy not installed.`;
    log(message);
    return { cluster, dnsUpstream, exitCode: 1, message };
  }

  const vethGateway = parseVethGateway(
    commandOutput(
      kctl(
        runDocker,
        cluster,
        [
          "exec",
          "-n",
          "openshell",
          pod,
          "--",
          "sh",
          "-c",
          "ip addr show | grep 'inet 10\\.200\\.0\\.' | awk '{print $2}' | cut -d/ -f1",
        ],
        dockerEnv,
      ),
    ),
  );
  if (!isSafeDnsAddress(vethGateway)) {
    return { cluster, dnsUpstream, exitCode: 1, pod, message: `ERROR: VETH gateway '${vethGateway}' contains invalid characters.` };
  }

  log(`Setting up DNS proxy in pod '${pod}' (${vethGateway}:53 -> ${dnsUpstream})...`);

  const proxyWriter = `cat > /tmp/dns-proxy.py << 'DNSPROXY'\n${buildDnsProxyPython()}DNSPROXY`;
  kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "sh", "-c", proxyWriter], dockerEnv);

  const oldPid = commandOutput(kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "cat", "/tmp/dns-proxy.pid"], dockerEnv)).trim();
  if (oldPid) {
    kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "kill", oldPid], dockerEnv);
    sleep(1000);
  }

  kctl(
    runDocker,
    cluster,
    [
      "exec",
      "-n",
      "openshell",
      pod,
      "--",
      "sh",
      "-c",
      `nohup python3 -u /tmp/dns-proxy.py ${shellSingleQuote(dnsUpstream)} ${shellSingleQuote(vethGateway)} > /tmp/dns-proxy.log 2>&1 &`,
    ],
    dockerEnv,
  );

  let dnsReady = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = kctl(
      runDocker,
      cluster,
      ["exec", "-n", "openshell", pod, "--", "python3", "-c", buildDnsReadyProbePython(vethGateway)],
      dockerEnv,
    );
    if (probe.stdout.includes("ok")) {
      dnsReady = true;
      break;
    }
    sleep(1000);
  }
  if (!dnsReady) log("WARNING: DNS forwarder not responding after 10s — verification may fail");

  const sandboxNamespace = selectSandboxNamespace(
    commandOutput(kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "sh", "-c", "ls /run/netns/ 2>/dev/null"], dockerEnv)),
  );

  let iptablesBin = "";
  if (!sandboxNamespace) {
    log("WARNING: Could not find sandbox network namespace. DNS may not work.");
  } else {
    for (const candidate of ["iptables", "/sbin/iptables", "/usr/sbin/iptables"]) {
      const test = kctl(
        runDocker,
        cluster,
        ["exec", "-n", "openshell", pod, "--", "sh", "-c", `test -x "$(command -v ${candidate} 2>/dev/null || echo ${candidate})"`],
        dockerEnv,
      );
      if (test.status === 0) {
        iptablesBin = candidate;
        break;
      }
    }

    kctl(
      runDocker,
      cluster,
      [
        "exec",
        "-n",
        "openshell",
        pod,
        "--",
        "ip",
        "netns",
        "exec",
        sandboxNamespace,
        "sh",
        "-c",
        "[ -f /tmp/resolv.conf.orig ] || cp /etc/resolv.conf /tmp/resolv.conf.orig",
      ],
      dockerEnv,
    );

    if (iptablesBin) {
      const iptablesPrefix = [
        "exec",
        "-n",
        "openshell",
        pod,
        "--",
        "ip",
        "netns",
        "exec",
        sandboxNamespace,
        iptablesBin,
      ];
      const iptablesRule = ["-p", "udp", "-d", vethGateway, "--dport", "53", "-j", "ACCEPT"];
      const check = kctl(runDocker, cluster, [...iptablesPrefix, "-C", "OUTPUT", ...iptablesRule], dockerEnv);
      if (check.status !== 0) {
        kctl(runDocker, cluster, [...iptablesPrefix, "-I", "OUTPUT", "1", ...iptablesRule], dockerEnv);
      }

      kctl(
        runDocker,
        cluster,
        [
          "exec",
          "-n",
          "openshell",
          pod,
          "--",
          "ip",
          "netns",
          "exec",
          sandboxNamespace,
          "sh",
          "-c",
          `printf ${shellSingleQuote(buildResolvConf(vethGateway))} > /etc/resolv.conf`,
        ],
        dockerEnv,
      );
    } else {
      log("WARNING: iptables not found in pod (checked PATH, /sbin, /usr/sbin).");
      log("WARNING: Cannot add UDP DNS exception. Sandbox DNS resolution will not work.");
      kctl(
        runDocker,
        cluster,
        [
          "exec",
          "-n",
          "openshell",
          pod,
          "--",
          "ip",
          "netns",
          "exec",
          sandboxNamespace,
          "sh",
          "-c",
          "[ -f /tmp/resolv.conf.orig ] && cp /tmp/resolv.conf.orig /etc/resolv.conf",
        ],
        dockerEnv,
      );
    }
  }

  let verificationPass = 0;
  let verificationFail = 0;
  const pid = commandOutput(kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "cat", "/tmp/dns-proxy.pid"], dockerEnv)).trim();
  const dnsLog = commandOutput(kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "cat", "/tmp/dns-proxy.log"], dockerEnv)).trim();
  if (pid && dnsLog.includes("dns-proxy:")) {
    log(`  [PASS] DNS forwarder running (pid=${pid}): ${dnsLog}`);
    verificationPass += 1;
  } else {
    log(`  [FAIL] DNS forwarder not running. PID=${pid || "none"} Log: ${dnsLog || "empty"}`);
    verificationFail += 1;
  }

  const sbExec = (args: string[]) =>
    sandboxNamespace
      ? kctl(runDocker, cluster, ["exec", "-n", "openshell", pod, "--", "ip", "netns", "exec", sandboxNamespace, ...args], dockerEnv)
      : null;

  if (sandboxNamespace) {
    const resolv = commandOutput(sbExec(["cat", "/etc/resolv.conf"]) ?? { status: 1, stdout: "", stderr: "" });
    if (resolv.includes(`nameserver ${vethGateway}`)) {
      log(`  [PASS] resolv.conf -> nameserver ${vethGateway}`);
      verificationPass += 1;
    } else {
      log(`  [FAIL] resolv.conf does not point to ${vethGateway}: ${resolv}`);
      verificationFail += 1;
    }

    const iptablesCheck = sbExec([iptablesBin || "iptables", "-C", "OUTPUT", "-p", "udp", "-d", vethGateway, "--dport", "53", "-j", "ACCEPT"]);
    if (iptablesCheck?.status === 0) {
      log(`  [PASS] iptables: UDP ${vethGateway}:53 ACCEPT rule present`);
      verificationPass += 1;
    } else {
      log("  [FAIL] iptables: UDP DNS ACCEPT rule missing");
      verificationFail += 1;
    }

    let dnsResult = "";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      dnsResult = commandOutput(sbExec(["getent", "hosts", "github.com"]) ?? { status: 1, stdout: "", stderr: "" }).trim();
      if (dnsResult) break;
      if (attempt < 3) sleep(2000);
    }
    if (dnsResult) {
      log(`  [PASS] getent hosts github.com -> ${dnsResult}`);
      verificationPass += 1;
    } else {
      log("  [FAIL] getent hosts github.com returned empty after 3 attempts (DNS not resolving)");
      verificationFail += 1;
    }
  } else {
    log("  [SKIP] Sandbox namespace not found; cannot verify resolv.conf, iptables, or DNS");
  }

  log(`  DNS verification: ${verificationPass} passed, ${verificationFail} failed`);
  if (verificationFail > 0) log("WARNING: DNS setup incomplete. Sandbox DNS resolution may not work. See issue #626, #557.");

  return {
    cluster,
    dnsUpstream,
    exitCode: 0,
    pod,
    sandboxNamespace: sandboxNamespace ?? undefined,
    verificationFail,
    verificationPass,
    vethGateway,
  };
}
