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
 * The ambient port runs last. Once the other ports are gone, its own sibling
 * detection sees an empty host and completes the host-shared cleanup that a
 * scoped run has to skip. A port whose pass failed still counts as a live
 * sibling, so a partial sweep degrades to a scoped uninstall instead of
 * removing shared state out from under a surviving environment.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";

import { type AgentBranding, getAgentBranding } from "../../cli/branding";
import { GATEWAY_PORT } from "../../core/ports";
import { spawnExitCode } from "../../core/process-exit";
import { readLineFromStdin } from "../../core/stdin";
import { resolveGatewayName } from "../../onboard/gateway-binding";
import { listGatewayStateRoots } from "../../state/gateway-registry";
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
  runPortPass?: (port: number, options: UninstallRunOptions, env: NodeJS.ProcessEnv) => number;
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
  return listGatewayStateRoots(home).map((root) => root.gatewayPort);
}

export function uninstallChildArgs(options: UninstallRunOptions): string[] {
  const args = ["internal", "uninstall", "run-plan", "--yes", "--all-gateway-ports-child"];
  if (options.deleteModels) args.push("--delete-models");
  if (options.destroyUserData) args.push("--destroy-user-data");
  if (options.keepOpenShell) args.push("--keep-openshell");
  return args;
}

/**
 * The child must never re-enter the sweep: dropping the request variable keeps
 * an inherited `NEMOCLAW_UNINSTALL_ALL_GATEWAY_PORTS=1` from recursing.
 */
export function uninstallChildEnv(env: NodeJS.ProcessEnv, port: number): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, NEMOCLAW_GATEWAY_PORT: String(port) };
  delete next[ALL_GATEWAY_PORTS_ENV];
  if (port !== GATEWAY_PORT) delete next.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  return next;
}

function defaultRunPortPass(
  port: number,
  options: UninstallRunOptions,
  env: NodeJS.ProcessEnv,
): number {
  const entry = process.argv[1];
  if (!entry) return 1;
  return spawnExitCode(
    spawnSync(process.execPath, [entry, ...uninstallChildArgs(options)], {
      env: uninstallChildEnv(env, port),
      stdio: "inherit",
    }),
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
  log("Each port is uninstalled in turn; the current port is uninstalled last.");
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
  const runPortPass = deps.runPortPass ?? defaultRunPortPass;
  const runSelectedPass = deps.runSelectedPass ?? runUninstallPlanProduction;
  const runDeps = { ...deps, env };
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

  const otherPorts = [...new Set(discovered)]
    .filter((port) => port !== GATEWAY_PORT)
    .sort((left, right) => left - right);
  if (otherPorts.length === 0) {
    let selected: Pick<UninstallRunOutcome, "exitCode" | "otherGatewayEnvironmentsRemain">;
    try {
      selected = await runSelectedPass(options, {
        ...runDeps,
        requireCompleteGatewayProcessCleanup: true,
        retainedGatewayPorts: [],
      });
    } catch (failure) {
      error(
        `Whole-host selected gateway uninstall failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      return { exitCode: 1, ports: [GATEWAY_PORT] };
    }
    if (selected.otherGatewayEnvironmentsRemain) {
      error("Whole-host uninstall is incomplete because another gateway-port environment remains.");
      return { exitCode: 1, ports: [GATEWAY_PORT] };
    }
    return { exitCode: selected.exitCode, ports: [GATEWAY_PORT] };
  }

  const ordered = [...otherPorts, GATEWAY_PORT];
  if (!confirmSweep(options, ordered, branding, log, readLine)) {
    return { exitCode: 0, ports: ordered };
  }

  let exitCode = 0;
  const retainedGatewayPorts: number[] = [];
  for (const port of otherPorts) {
    log(`Uninstalling gateway '${resolveGatewayName(port)}' on port ${String(port)}.`);
    if (runPortPass(port, options, env) !== 0) {
      exitCode = 1;
      retainedGatewayPorts.push(port);
      error(`Uninstall failed for gateway port ${String(port)}; its resources may remain on disk.`);
    }
  }
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
