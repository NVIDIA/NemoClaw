// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whole-host uninstall sweep across every NemoClaw gateway port (#7791).
 *
 * A single uninstall is scoped to the gateway port its process resolved, so a
 * host that onboarded under more than one NEMOCLAW_GATEWAY_PORT keeps the other
 * ports bound. That scoping is deliberate (#4422, #7279): one environment must
 * never tear down another. This sweep is the explicit opt-in that asks for all
 * of them, and it runs each port in its own process so every port-scoped value
 * including the state root, registry file, gateway name, and Docker names, resolves from that
 * port rather than from the ambient environment.
 *
 * The ambient port runs last when it exists. When it does not, the final
 * discovered child sees an empty host and completes the host-shared cleanup
 * that earlier scoped runs have to skip. A port whose pass failed still counts
 * as a live sibling, so a partial sweep degrades to a scoped uninstall instead
 * of removing shared state out from under a surviving environment. The shared
 * root is listed as the default gateway only when registry or gateway-config
 * evidence proves that environment exists (#13332).
 */

import { spawnSync } from "node:child_process";
import os from "node:os";

import { type AgentBranding, getAgentBranding } from "../../cli/branding";
import { DEFAULT_GATEWAY_PORT, GATEWAY_PORT } from "../../core/ports";
import { spawnExitCode } from "../../core/process-exit";
import { readLineFromStdin } from "../../core/stdin";
import { resolveGatewayName } from "../../onboard/gateway-binding";
import { listGatewayStateRoots, readGatewayOpenShellStateDir } from "../../state/gateway-registry";
import { hasDefaultGatewayEvidence } from "./default-gateway-evidence";
import {
  runUninstallPlanProduction,
  type UninstallRunDeps,
  type UninstallRunOptions,
  type UninstallRunOutcome,
} from "./run-plan";

export const ALL_GATEWAY_PORTS_ENV = "NEMOCLAW_UNINSTALL_ALL_GATEWAY_PORTS";

export interface AllGatewayPortsDeps extends UninstallRunDeps {
  home?: string;
  listGatewayPorts?: (home: string) => readonly number[];
  gatewayStateDirForPort?: (home: string, port: number) => string | null;
  runPortPass?: (
    port: number,
    options: UninstallRunOptions,
    env: NodeJS.ProcessEnv,
    retainedGatewayPorts?: readonly number[],
    sweepDefaultGatewayAbsent?: boolean,
  ) => number;
  runSelectedPass?: (
    options: UninstallRunOptions,
    deps: UninstallRunDeps,
  ) => Promise<Pick<UninstallRunOutcome, "exitCode" | "otherGatewayEnvironmentsRemain">>;
}

export interface AllGatewayPortsOutcome {
  exitCode: number;
  ports: readonly number[];
}

/** True when the flag or the environment variable asks for the sweep. */
export function allGatewayPortsRequested(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flag === true || env[ALL_GATEWAY_PORTS_ENV] === "1";
}

function defaultListGatewayPorts(home: string): readonly number[] {
  const roots = listGatewayStateRoots(home);
  const hasDefaultGateway = hasDefaultGatewayEvidence(home);
  return roots
    .filter(({ gatewayPort }) => gatewayPort !== DEFAULT_GATEWAY_PORT || hasDefaultGateway)
    .map((root) => root.gatewayPort);
}

export function uninstallChildArgs(
  options: UninstallRunOptions,
  retainedGatewayPorts: readonly number[] = [],
  sweepDefaultGatewayAbsent = false,
): string[] {
  const args = ["internal", "uninstall", "run-plan", "--yes", "--all-gateway-ports-child"];
  if (sweepDefaultGatewayAbsent) args.push("--sweep-default-gateway-absent");
  if (options.deleteModels) args.push("--delete-models");
  if (options.destroyUserData) args.push("--destroy-user-data");
  if (options.forceFreshReset) args.push("--force-fresh-reset");
  if (options.keepOpenShell) args.push("--keep-openshell");
  for (const port of retainedGatewayPorts) {
    args.push("--retained-gateway-port", String(port));
  }
  return args;
}

/**
 * The child must never re-enter the sweep: dropping the request variable keeps
 * an inherited `NEMOCLAW_UNINSTALL_ALL_GATEWAY_PORTS=1` from recursing.
 */
export function uninstallChildEnv(
  env: NodeJS.ProcessEnv,
  port: number,
  recordedGatewayStateDir?: string | null,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, NEMOCLAW_GATEWAY_PORT: String(port) };
  delete next[ALL_GATEWAY_PORTS_ENV];
  if (port !== GATEWAY_PORT) {
    if (recordedGatewayStateDir) {
      next.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = recordedGatewayStateDir;
    } else {
      delete next.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    }
  }
  return next;
}

function defaultRunPortPass(
  _port: number,
  options: UninstallRunOptions,
  env: NodeJS.ProcessEnv,
  retainedGatewayPorts: readonly number[] = [],
  sweepDefaultGatewayAbsent = false,
): number {
  const entry = process.argv[1];
  if (!entry) return 1;
  return spawnExitCode(
    spawnSync(
      process.execPath,
      [entry, ...uninstallChildArgs(options, retainedGatewayPorts, sweepDefaultGatewayAbsent)],
      {
        env,
        stdio: "inherit",
      },
    ),
  );
}

function confirmSweep(
  options: UninstallRunOptions,
  ports: readonly number[],
  branding: AgentBranding,
  log: (message: string) => void,
  readLine: () => string | null,
): boolean {
  if (options.assumeYes) return true;
  log(`This will remove ${branding.display} resources for every gateway port on this host:`);
  for (const port of ports) {
    log(`  · gateway '${resolveGatewayName(port)}' on port ${String(port)}`);
  }
  log("Each listed port is uninstalled in order; the last listed port runs last.");
  log("Proceed? [y/N]");
  const reply = readLine();
  if (reply && /^(y|yes)$/i.test(reply.trim())) return true;
  if (reply === null) {
    log(
      "No input available on stdin (closed or non-interactive); rerun with --yes to skip this prompt.",
    );
  }
  log("Aborted.");
  return false;
}

export async function runUninstallAllGatewayPorts(
  options: UninstallRunOptions,
  deps: AllGatewayPortsDeps = {},
): Promise<AllGatewayPortsOutcome> {
  const env = { ...process.env, ...(deps.env ?? {}) };
  const branding = getAgentBranding(deps.env?.NEMOCLAW_AGENT ?? process.env.NEMOCLAW_AGENT);
  const home = deps.home ?? deps.env?.HOME ?? process.env.HOME ?? os.homedir();
  const log = deps.log ?? ((message: string) => console.log(message));
  const error = deps.error ?? ((message: string) => console.error(message));
  const readLine = deps.readLine ?? (() => readLineFromStdin());
  const listPorts = deps.listGatewayPorts ?? defaultListGatewayPorts;
  const gatewayStateDirForPort = deps.gatewayStateDirForPort ?? readGatewayOpenShellStateDir;
  const runPortPass = deps.runPortPass ?? defaultRunPortPass;
  const runSelectedPass = deps.runSelectedPass ?? runUninstallPlanProduction;
  const expectedGatewayName = resolveGatewayName(GATEWAY_PORT);

  if (options.gatewayName && options.gatewayName !== expectedGatewayName) {
    error(
      `Refusing to uninstall gateway '${options.gatewayName}': NEMOCLAW_GATEWAY_PORT=${String(GATEWAY_PORT)} selects '${expectedGatewayName}'.`,
    );
    return { exitCode: 1, ports: [] };
  }

  let discovered: readonly number[];
  try {
    discovered = listPorts(home);
  } catch (failure) {
    error(
      `Cannot enumerate ${branding.display} gateway ports: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
    );
    return { exitCode: 1, ports: [] };
  }

  const selectedPortIsDiscovered = discovered.includes(GATEWAY_PORT);
  const sweepDefaultGatewayAbsent = !discovered.includes(DEFAULT_GATEWAY_PORT);
  const otherPorts = [...new Set(discovered)]
    .filter((port) => port !== GATEWAY_PORT)
    .sort((left, right) => left - right);
  const ordered = [...otherPorts, ...(selectedPortIsDiscovered ? [GATEWAY_PORT] : [])];
  const recordedStateDirs = new Map<number, string>();
  try {
    for (const port of ordered) {
      const recorded = gatewayStateDirForPort(home, port);
      if (recorded) recordedStateDirs.set(port, recorded);
    }
  } catch (failure) {
    error(
      `Cannot recover per-gateway OpenShell state directories: ${
        failure instanceof Error ? failure.message : String(failure)
      }`,
    );
    return { exitCode: 1, ports: ordered };
  }
  const selectedRecordedStateDir = recordedStateDirs.get(GATEWAY_PORT);
  const selectedEnv =
    selectedRecordedStateDir && !env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim()
      ? { ...env, NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: selectedRecordedStateDir }
      : env;
  const runDeps = { ...deps, env: selectedEnv };

  if (otherPorts.length === 0) {
    let selected: Pick<UninstallRunOutcome, "exitCode" | "otherGatewayEnvironmentsRemain">;
    try {
      selected = await runSelectedPass(options, {
        ...runDeps,
        requireCompleteGatewayProcessCleanup: true,
        retainedGatewayPorts: [],
        sweepDefaultGatewayAbsent,
      });
    } catch (failure) {
      error(
        `Whole-host selected gateway uninstall failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      return { exitCode: 1, ports: ordered };
    }
    if (selected.otherGatewayEnvironmentsRemain) {
      error("Whole-host uninstall is incomplete because another gateway-port environment remains.");
      return { exitCode: 1, ports: ordered };
    }
    return { exitCode: selected.exitCode, ports: ordered };
  }

  if (!confirmSweep(options, ordered, branding, log, readLine)) {
    return { exitCode: 0, ports: ordered };
  }

  let exitCode = 0;
  const retainedGatewayPorts: number[] = [];
  const finalOtherPort = selectedPortIsDiscovered ? null : otherPorts.at(-1);
  for (const port of otherPorts) {
    const recordedStateDir = recordedStateDirs.get(port);
    log(`Uninstalling gateway '${resolveGatewayName(port)}' on port ${String(port)}.`);
    if (recordedStateDir) {
      log(
        `Using recorded OpenShell gateway state directory ${JSON.stringify(recordedStateDir)} for port ${String(port)}.`,
      );
    }
    const retainedForChild = port === finalOtherPort ? retainedGatewayPorts : [];
    if (
      runPortPass(
        port,
        options,
        uninstallChildEnv(env, port, recordedStateDir),
        retainedForChild,
        port === finalOtherPort && sweepDefaultGatewayAbsent,
      ) !== 0
    ) {
      exitCode = 1;
      retainedGatewayPorts.push(port);
      error(
        recordedStateDir
          ? `Uninstall failed for gateway port ${String(port)} using recorded OpenShell state directory ${JSON.stringify(recordedStateDir)}; its resources may remain on disk.`
          : `Uninstall failed for gateway port ${String(port)}; its resources may remain on disk.`,
      );
    }
  }
  if (!selectedPortIsDiscovered) return { exitCode, ports: ordered };
  log(
    `Uninstalling gateway '${resolveGatewayName(GATEWAY_PORT)}' on port ${String(GATEWAY_PORT)}.`,
  );
  let selected: Pick<UninstallRunOutcome, "exitCode" | "otherGatewayEnvironmentsRemain">;
  try {
    selected = await runSelectedPass(
      { ...options, assumeYes: true },
      {
        ...runDeps,
        requireCompleteGatewayProcessCleanup: true,
        retainedGatewayPorts,
        sweepDefaultGatewayAbsent,
      },
    );
  } catch (failure) {
    error(
      `Whole-host selected gateway uninstall failed: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    return { exitCode: 1, ports: ordered };
  }
  if (selected.exitCode !== 0) exitCode = 1;
  if (selected.otherGatewayEnvironmentsRemain) {
    exitCode = 1;
    error("Whole-host uninstall is incomplete because another gateway-port environment remains.");
  }
  return { exitCode, ports: ordered };
}
