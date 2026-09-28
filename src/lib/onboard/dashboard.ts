// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatOpenShellForwardStartFailure,
  type OpenShellForwardAdapter,
  type OpenShellForwardIdentity,
} from "../adapters/openshell/forward";
import {
  createOpenShellForwardAdapterForAuthority,
  openShellForwardIdentity,
  type OpenShellForwardRuntimeAuthority,
} from "../adapters/openshell/forward-runtime";
import { createCliOpenShellSandboxTransferExecutor } from "../adapters/openshell/sandbox-transfer-cli";
import type { OpenShellSandboxTransferExecutor } from "../adapters/openshell/sandbox-transfer";
import type { AgentDefinition } from "../agent/defs";
import { getInteractiveAgentCommand } from "../agent/gateway-restart-scripts";
import { DASHBOARD_PORT } from "../core/ports";
import { buildChain, buildControlUiUrls, buildFallbackControlUiUrls } from "../dashboard/contract";
import * as nim from "../inference/nim";
import { runCapture as defaultRunCapture } from "../runner";
import {
  ensureAgentDashboardForward as ensureAgentDashboardForwardForAgent,
  replaceUrlPort,
  resolveVerifyAgentApiPort,
} from "./agent-dashboard-forward";
import { fetchAgentWebAuthTokenFromSandbox as fetchAgentWebAuthToken } from "./agent-web-auth-token";
import * as dashboardAccess from "./dashboard-access";
import {
  type DashboardForwardOptions,
  normalizeDashboardForwardOptions,
} from "./dashboard-forward-control";
import {
  createOpenShellForwardPortObserver,
  findAvailableDashboardPortFromObserver,
  getPersistedDashboardPort,
  getRegistryOccupiedDashboardPorts,
  getRegistryOccupiedHermesApiPorts,
  type ListSandboxesFn,
  type OpenShellForwardPortObserver,
} from "./dashboard-port";
import { canReuseDashboardForwardForAgent, resolveDashboardForwardBind } from "./dashboard-runtime";
import {
  ensureMessagingHostForwardForSandbox,
  productionForwardServiceRegistryContext,
} from "./messaging-host-forward";
import { buildSshForwardHintLines } from "./ssh-forward-hint";

export const CONTROL_UI_PORT = DASHBOARD_PORT;

function looksLikeForwardPortConflict(diagnostic: string): boolean {
  return /eaddrinuse|address already in use|port .* in use|bind: .*in use/iu.test(diagnostic);
}

type DashboardForwardRuntimeAuthority = OpenShellForwardRuntimeAuthority;

export interface OnboardDashboardDeps {
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
  runCapture?: typeof defaultRunCapture;
  cliName(): string;
  agentProductName(): string;
  getProviderLabel(provider: string): string;
  nimStatus?: typeof nim.nimStatus;
  nimStatusByName?: typeof nim.nimStatusByName;
  shouldShowNimLine?: typeof nim.shouldShowNimLine;
  note(message: string): void;
  isWsl(): boolean;
  redact(value: unknown): string;
  sleep(seconds: number): void;
  sandboxTransferExecutor?: OpenShellSandboxTransferExecutor;
  productionForwardService?: boolean;
  /** Endpoint and optional client TLS bundle selected by the bound gateway authority. */
  getGatewayForwardRuntimeAuthority?(): {
    readonly gatewayEndpoint: string;
    readonly localTlsDir?: string;
  };
  /** Environment used to detect an SSH session for the port-forward hint. */
  env?: NodeJS.ProcessEnv;
  // Sandbox-registry lookup used by `ensureDashboardForward` for the
  // cross-gateway dashboard port view. Tests inject a stub so the allocator
  // never reads the runner's real `~/.nemoclaw/sandboxes.json`; production
  // callers leave it unset and the helper falls back to the live registry.
  listSandboxes?: ListSandboxesFn;
  /** Sandbox lookup used to resolve the per-sandbox Hermes API port. */
  getSandbox?(name: string):
    | {
        gatewayName?: string | null;
        gatewayPort?: number | null;
        dashboardPort?: number | null;
        dashboardRemoteBindPrepared?: boolean;
        hermesApiPort?: number | null;
        hermesDashboardPort?: number | null;
        lifecycleLiveIdentityFingerprint?: string;
        pendingRouteReservation?: true;
      }
    | null
    | undefined;
  /** Typed forwarding adapter factory. Tests inject a fake; production uses the CLI adapter. */
  forwardAdapterForAuthority?: (
    authority: DashboardForwardRuntimeAuthority,
  ) => OpenShellForwardAdapter;
  resolveForwardGatewayName?(
    sandbox: { gatewayName?: string | null; gatewayPort?: number | null } | null | undefined,
  ): string;
  printAgentDashboardUi(
    sandboxName: string,
    token: string | null,
    agent: AgentDefinition,
    deps: {
      note: (msg: string) => void;
      buildControlUiUrls: (token: string | null, port: number) => string[];
      effectiveDashboardPort?: number;
    },
  ): void;
}

/** Agent fields the deployment-verification chain reads. */
export type VerifyChainAgent = {
  name?: string;
  dashboard?: { healthPath?: string } | null;
  healthProbe?: { url?: string; port?: number } | null;
};

export interface OnboardDashboardHelpers {
  buildChain: typeof buildChain;
  buildAgentVerifyChain(
    chatUiUrl: string,
    sandboxName: string,
    agent: VerifyChainAgent | null | undefined,
  ): ReturnType<typeof buildChain>;
  buildControlUiUrls: typeof buildControlUiUrls;
  buildOrphanedSandboxRollbackMessage(
    sandboxName: string,
    err: unknown,
    gatewayName?: string,
  ): string[];
  ensureDashboardForward(
    sandboxName: string,
    chatUiUrl?: string,
    options?: DashboardForwardOptions,
  ): Promise<number>;
  ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null; forward_ports?: number[] | null },
    options?: {
      beforeForwardPort?: (port: number) => Promise<void> | void;
      revalidateSandboxIdentity?: (operation: string) => void;
    },
  ): Promise<number>;
  ensureFinalizationDashboardForward(
    sandboxName: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<number>;
  ensureFinalizationAgentDashboardForward(
    sandboxName: string,
    agent: { name: string; forwardPort?: number | null; forward_ports?: number[] | null } | null,
    revalidateSandboxIdentity?: (operation: string) => void,
    portReservation?: {
      releaseBeforeForward(agentName: string, port: number): Promise<void> | void;
    },
  ): Promise<number>;
  ensureAgentFixedForward(
    sandboxName: string,
    port: number,
    label: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<boolean>;
  fetchGatewayAuthTokenFromSandbox(sandboxName: string): Promise<string | null>;
  fetchAgentWebAuthTokenFromSandbox(sandboxName: string, agent: AgentDefinition): string | null;
  getDashboardForwardPort(
    chatUiUrl?: string,
    options?: Parameters<typeof dashboardAccess.getDashboardForwardPort>[1],
  ): string;
  getDashboardForwardTarget(
    chatUiUrl?: string,
    options?: Parameters<typeof dashboardAccess.getDashboardForwardTarget>[1],
  ): string;
  createForwardPortObserver(
    sandboxName: string,
    targetKind?: "dashboard" | "loopback",
  ): OpenShellForwardPortObserver;
  printDashboard(
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer?: string | null,
    agent?: AgentDefinition | null,
    ready?: boolean,
  ): Promise<void>;
  stopAllDashboardForwards(): void;
}

function findOpenclawJsonPath(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found: string | null = findOpenclawJsonPath(entryPath);
      if (found) return found;
    } else if (entry.name === "openclaw.json") {
      return entryPath;
    }
  }
  return null;
}

function dashboardUrlForDisplay(url: string, deps: OnboardDashboardDeps): string {
  return dashboardAccess.dashboardUrlForDisplay(url, deps.redact);
}

function printWslFallback(fallbackDashboardUrls: string[], indent: string): void {
  if (fallbackDashboardUrls.length === 0) return;
  console.log("");
  console.log(`${indent}Browser (WSL fallback, if 127.0.0.1 is unreachable from Windows):`);
  for (const fallbackUrl of fallbackDashboardUrls) {
    console.log(`${indent}  ${fallbackUrl}`);
  }
}

export function createOnboardDashboardHelpers(deps: OnboardDashboardDeps): OnboardDashboardHelpers {
  const runCapture = deps.runCapture ?? defaultRunCapture;
  const productionForwardRegistry = deps.productionForwardService
    ? productionForwardServiceRegistryContext()
    : null;
  const getSandbox = deps.getSandbox ?? productionForwardRegistry?.getSandbox;
  const listSandboxes = deps.listSandboxes ?? productionForwardRegistry?.listSandboxes;
  const resolveGatewayName =
    deps.resolveForwardGatewayName ?? productionForwardRegistry?.resolveGatewayName;
  const forwardAdapterForAuthority =
    deps.forwardAdapterForAuthority ?? createOpenShellForwardAdapterForAuthority;

  function resolveForwardServiceGateway(
    sandboxName: string,
    options: DashboardForwardOptions = {},
  ): string | null {
    if (!resolveGatewayName) return null;
    const sandbox = getSandbox?.(sandboxName);
    options.revalidateSandboxIdentity?.(`launch ForwardTcp service for sandbox '${sandboxName}'`);
    return options.gatewayName ?? resolveGatewayName(sandbox);
  }

  function getForwardRuntimeAuthority(
    sandboxName: string,
    gatewayName: string,
  ): DashboardForwardRuntimeAuthority {
    const authority = deps.getGatewayForwardRuntimeAuthority?.();
    if (!authority) {
      throw new Error(`ForwardTcp gateway authority is unavailable for '${sandboxName}'`);
    }
    return {
      gatewayEndpoint: authority.gatewayEndpoint,
      gatewayName,
      workspace: "default",
      ...(authority.localTlsDir ? { localTlsDir: authority.localTlsDir } : {}),
    };
  }

  async function assertForwardGatewayCurrent(
    expected: DashboardForwardRuntimeAuthority,
    revalidateSandboxIdentity?: (operation: string) => void,
    operation?: string,
  ): Promise<void> {
    const current = deps.getGatewayForwardRuntimeAuthority?.();
    if (
      !current ||
      current.gatewayEndpoint !== expected.gatewayEndpoint ||
      current.localTlsDir !== expected.localTlsDir
    ) {
      throw new Error("ForwardTcp gateway authority changed during launch");
    }
    if (operation) revalidateSandboxIdentity?.(operation);
  }

  function forwardIdentity(
    sandboxName: string,
    authority: DashboardForwardRuntimeAuthority,
    port: number,
    targetKind: "dashboard" | "loopback",
  ): OpenShellForwardIdentity {
    const localHost =
      targetKind === "dashboard"
        ? resolveDashboardForwardBind(getSandbox?.(sandboxName), {
            requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
            wsl: deps.isWsl(),
          })
        : "127.0.0.1";
    return openShellForwardIdentity(authority, sandboxName, localHost, port);
  }

  function createForwardPortObserver(
    sandboxName: string,
    targetKind: "dashboard" | "loopback" = "dashboard",
  ): OpenShellForwardPortObserver {
    const gatewayName = resolveForwardServiceGateway(sandboxName);
    if (gatewayName === null) {
      throw new Error(`ForwardTcp gateway selection is unavailable for '${sandboxName}'`);
    }
    const authority = getForwardRuntimeAuthority(sandboxName, gatewayName);
    return createOpenShellForwardPortObserver({
      adapter: forwardAdapterForAuthority(authority),
      forwardForPort: (port) => forwardIdentity(sandboxName, authority, port, targetKind),
      assertCurrent: () => assertForwardGatewayCurrent(authority),
    });
  }

  function getDashboardForwardPort(
    chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: Parameters<typeof dashboardAccess.getDashboardForwardPort>[1] = {},
  ): string {
    return dashboardAccess.getDashboardForwardPort(chatUiUrl, {
      ...options,
      runCapture: options.runCapture || runCapture,
    });
  }

  function getDashboardForwardTarget(
    chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: Parameters<typeof dashboardAccess.getDashboardForwardTarget>[1] = {},
  ): string {
    return dashboardAccess.getDashboardForwardTarget(chatUiUrl, {
      ...options,
      runCapture: options.runCapture || runCapture,
    });
  }

  /**
   * Build the delivery chain deployment verification probes for `sandboxName`.
   *
   * Resolves the agent's OpenAI-compatible API port for this sandbox rather
   * than the agent manifest default, so verification probes the port this
   * sandbox actually publishes on the host (#9290).
   */
  function buildAgentVerifyChain(
    chatUiUrl: string,
    sandboxName: string,
    agent: VerifyChainAgent | null | undefined,
  ): ReturnType<typeof buildChain> {
    // One resolver for the host hints, so this chain and the forward's chain
    // cannot disagree about WSL, its fallback address, or the bind override
    // (#10861).
    return buildChain({
      chatUiUrl,
      ...dashboardAccess.resolveDashboardPlatformHints({ isWsl: deps.isWsl(), runCapture }),
      dashboardHealthEndpoint: agent?.dashboard?.healthPath,
      gatewayPort: resolveVerifyAgentApiPort(sandboxName, agent, {
        getSandbox,
      }),
      gatewayHealthEndpoint: agent?.healthProbe?.url,
    });
  }

  function stopAllDashboardForwards(): void {
    // Direct ForwardTcp services exit with their gateway. Legacy SSH forwards
    // are deliberately left to gateway teardown because OpenShell's shared PID
    // record cannot atomically bind a stop to the process NemoClaw inspected.
  }

  function buildOrphanedSandboxRollbackMessage(
    sandboxName: string,
    err: unknown,
    gatewayName?: string,
  ): string[] {
    const owningGateway = gatewayName?.trim();
    const lines = [
      "",
      `  Could not allocate a dashboard port for '${sandboxName}'.`,
      `  ${err instanceof Error ? err.message : String(err)}`,
      "  NemoClaw left the sandbox running because OpenShell deletion targets a mutable name.",
    ];
    if (owningGateway) {
      lines.push(
        `  Recovery remains blocked while gateway ${JSON.stringify(owningGateway)} reports this sandbox present.`,
        `  Do not delete it by mutable name; run 'nemoclaw ${sandboxName} destroy' to check for authoritative absence.`,
      );
    } else {
      lines.push("  The owning OpenShell gateway is unknown. Do not delete a same-name sandbox.");
    }
    return lines;
  }

  function rollbackSandboxAndExit(sandboxName: string, err: unknown, gatewayName?: string): never {
    for (const line of buildOrphanedSandboxRollbackMessage(sandboxName, err, gatewayName)) {
      console.error(line);
    }
    process.exit(1);
  }

  function forwardResultMessage(
    result:
      | Awaited<ReturnType<OpenShellForwardAdapter["startForward"]>>
      | Awaited<ReturnType<OpenShellForwardAdapter["retireLegacyForward"]>>,
  ): string {
    if ("error" in result) {
      const failure = "failure" in result ? result.failure : undefined;
      const suffix = failure ? ` [${formatOpenShellForwardStartFailure(failure)}]` : "";
      return `${result.error.message}${suffix}`;
    }
    if ("observation" in result) {
      return result.observation.state === "foreign"
        ? "The host port is owned by a foreign listener."
        : "NemoClaw could not prove the forward state.";
    }
    return "NemoClaw could not reconcile the forward state.";
  }

  async function reconcileForward(
    sandboxName: string,
    authority: DashboardForwardRuntimeAuthority,
    forward: OpenShellForwardIdentity,
    label: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<void> {
    const adapter = forwardAdapterForAuthority(authority);
    const assertCurrent = () =>
      assertForwardGatewayCurrent(
        authority,
        revalidateSandboxIdentity,
        `accept ${label} forward ${String(forward.port)} for sandbox '${sandboxName}'`,
      );
    let result = await adapter.startForward({ forward, assertCurrent });
    if (result.state === "refused" && result.observation.state === "stale") {
      const retirement = await adapter.retireLegacyForward({
        forward,
        assertCurrent,
        authorize: async () => {
          await assertForwardGatewayCurrent(
            authority,
            revalidateSandboxIdentity,
            `retire legacy ${label} forward ${String(forward.port)} for sandbox '${sandboxName}'`,
          );
        },
      });
      if (retirement.state !== "retired" && retirement.state !== "not_needed") {
        throw new Error(forwardResultMessage(retirement));
      }
      result = await adapter.startForward({ forward, assertCurrent });
    }
    if (result.state !== "started" && result.state !== "reused") {
      throw new Error(forwardResultMessage(result));
    }
  }

  async function ensureDashboardForward(
    sandboxName: string,
    chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
    options: DashboardForwardOptions = {},
  ): Promise<number> {
    chatUiUrl ||= `http://127.0.0.1:${CONTROL_UI_PORT}`;
    const { rollbackSandboxOnFailure, allowPortReallocation, reuseExistingForward } =
      normalizeDashboardForwardOptions(options);
    const { revalidateSandboxIdentity } = options;
    const preferredPort = Number(getDashboardForwardPort(chatUiUrl));
    const forwardGateway = resolveForwardServiceGateway(sandboxName, options);
    if (!forwardGateway) {
      throw new Error(`ForwardTcp authority is unavailable for '${sandboxName}'`);
    }
    const authority = getForwardRuntimeAuthority(sandboxName, forwardGateway);
    const forwardAdapter = forwardAdapterForAuthority(authority);
    const observeForwardPorts = createOpenShellForwardPortObserver({
      adapter: forwardAdapter,
      forwardForPort: (port) => forwardIdentity(sandboxName, authority, port, "dashboard"),
      assertCurrent: () =>
        assertForwardGatewayCurrent(
          authority,
          revalidateSandboxIdentity,
          `inspect dashboard forwards for sandbox '${sandboxName}'`,
        ),
    });
    const persistedPort = getPersistedDashboardPort(sandboxName, listSandboxes);
    const registryOccupiedPorts = new Map([
      ...getRegistryOccupiedDashboardPorts(sandboxName, listSandboxes),
      ...getRegistryOccupiedHermesApiPorts(sandboxName, listSandboxes),
    ]);
    const fixedPort = persistedPort === preferredPort || reuseExistingForward;
    if (fixedPort && registryOccupiedPorts.has(String(preferredPort))) {
      throw new Error(
        `Port ${String(preferredPort)} is not available for '${sandboxName}'; another sandbox registered it.`,
      );
    }
    let actualPort: number;
    try {
      actualPort = (
        await findAvailableDashboardPortFromObserver(
          sandboxName,
          preferredPort,
          observeForwardPorts,
          registryOccupiedPorts,
        )
      ).port;
    } catch (err) {
      if (!rollbackSandboxOnFailure) throw err;
      rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
    }

    if (actualPort !== preferredPort) {
      if (!allowPortReallocation || fixedPort) {
        throw new Error(
          `Port ${preferredPort} is not available for '${sandboxName}' and cannot be reallocated.`,
        );
      }
      if (rollbackSandboxOnFailure) {
        const err = new Error(
          `Dashboard port ${preferredPort} became host-bound during sandbox build; ` +
            `cannot reallocate to ${actualPort} after the sandbox has been created with ` +
            `CHAT_UI_URL=${preferredPort}. Free the port and re-run \`${deps.cliName()} onboard\`, ` +
            `or pass \`--control-ui-port <N>\` to pick a different dashboard port.`,
        );
        rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
      }
      console.warn(`  ! Port ${preferredPort} is taken. Using port ${actualPort} instead.`);
    }

    const actualGateway = resolveForwardServiceGateway(sandboxName, options);
    let fwdOk = false;
    let fwdDiagnostic = "";
    if (actualGateway) {
      try {
        revalidateSandboxIdentity?.(
          `start dashboard forward ${String(actualPort)} for sandbox '${sandboxName}'`,
        );
        const actualAuthority = getForwardRuntimeAuthority(sandboxName, actualGateway);
        await reconcileForward(
          sandboxName,
          actualAuthority,
          forwardIdentity(sandboxName, actualAuthority, actualPort, "dashboard"),
          "dashboard",
          revalidateSandboxIdentity,
        );
        fwdOk = true;
      } catch (error) {
        fwdDiagnostic = error instanceof Error ? error.message : String(error);
      }
    } else {
      fwdDiagnostic = "ForwardTcp authority changed before service start";
    }
    if (!fwdOk) {
      const looksLikePortConflict = looksLikeForwardPortConflict(fwdDiagnostic);
      if (rollbackSandboxOnFailure) {
        const err = new Error(
          looksLikePortConflict
            ? `Failed to start dashboard forward on port ${actualPort} — the host port ` +
                `is held by another process. Free it and run \`${deps.cliName()} onboard\` again, ` +
                `or pass \`--control-ui-port <N>\` to pick a different dashboard port.`
            : `Failed to start dashboard forward on port ${actualPort}: ${fwdDiagnostic.slice(0, 240)}`,
        );
        rollbackSandboxAndExit(sandboxName, err, options.gatewayName);
      }
      throw new Error(
        `Failed to start dashboard forward on port ${actualPort} for '${sandboxName}': ${fwdDiagnostic.slice(0, 240)}. ` +
          "Inspect the listener before retrying onboarding.",
      );
    }
    if (fwdOk && rollbackSandboxOnFailure) {
      await ensureMessagingHostForwardForSandbox({
        sandboxName,
        ensureForward: (name, port, label) =>
          ensureAgentFixedForward(name, port, label, revalidateSandboxIdentity),
        note: deps.note,
        rollbackOnFailure: {
          buildRollbackMessage: (name, error) =>
            buildOrphanedSandboxRollbackMessage(name, error, options.gatewayName),
          cliName: deps.cliName,
        },
      });
    }
    return actualPort;
  }

  /**
   * Reconcile the dashboard forward for the agent-less OpenClaw finalization
   * branch. A resumed or repeated onboarding can skip sandbox creation, so
   * `CHAT_UI_URL` may not carry the port the in-sandbox gateway listens on;
   * the registry entry persisted by onboarding is the only record of that
   * port. The forward and the in-sandbox gateway must share one port number (`openshell forward`
   * binds the same port on both sides), so when the persisted port cannot be
   * forwarded this throws instead of reallocating: the resumed gateway only
   * listens on the persisted port, and a forward on any other port serves
   * nothing. Post-verify builds its probe chain and Browser URL from
   * `CHAT_UI_URL`, so after the forward starts this writes the bound port to
   * `CHAT_UI_URL`. (#8970)
   */
  async function ensureFinalizationDashboardForward(
    sandboxName: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<number> {
    const envUrl = process.env.CHAT_UI_URL;
    const persistedPort = envUrl ? null : getPersistedDashboardPort(sandboxName, listSandboxes);
    const requestedUrl =
      envUrl || (persistedPort === null ? undefined : `http://127.0.0.1:${String(persistedPort)}`);
    const actualPort = await ensureDashboardForward(sandboxName, requestedUrl, {
      allowPortReallocation: false,
      reuseExistingForward: true,
      ...(revalidateSandboxIdentity ? { revalidateSandboxIdentity } : {}),
    });
    revalidateSandboxIdentity?.(`publish the dashboard URL for sandbox '${sandboxName}'`);
    process.env.CHAT_UI_URL = replaceUrlPort(
      requestedUrl || `http://127.0.0.1:${String(actualPort)}`,
      actualPort,
    );
    return actualPort;
  }

  function ensureAgentDashboardForward(
    sandboxName: string,
    agent: { forwardPort?: number | null; forward_ports?: number[] | null },
    options: {
      beforeForwardPort?: (port: number) => Promise<void> | void;
      reuseExistingForward?: boolean;
      revalidateSandboxIdentity?: (operation: string) => void;
    } = {},
  ): Promise<number> {
    const chatUiUrl = process.env.CHAT_UI_URL;
    return ensureAgentDashboardForwardForAgent({
      sandboxName,
      agent,
      ensureDashboardForward,
      chatUiUrl,
      controlUiPort: chatUiUrl ? Number(getDashboardForwardPort(chatUiUrl)) : undefined,
      hermesApiPort: getSandbox?.(sandboxName)?.hermesApiPort,
      beforeForwardPort: options.beforeForwardPort,
      reuseExistingForward: options.reuseExistingForward,
      revalidateSandboxIdentity: options.revalidateSandboxIdentity,
    });
  }

  function ensureFinalizationAgentDashboardForward(
    sandboxName: string,
    agent: { name: string; forwardPort?: number | null; forward_ports?: number[] | null } | null,
    revalidateSandboxIdentity?: (operation: string) => void,
    portReservation?: {
      releaseBeforeForward(agentName: string, port: number): Promise<void> | void;
    },
  ): Promise<number> {
    if (!agent) {
      return ensureFinalizationDashboardForward(sandboxName, revalidateSandboxIdentity);
    }
    const mayReuseForward = canReuseDashboardForwardForAgent(agent);
    if (mayReuseForward) {
      const registeredPort = getPersistedDashboardPort(sandboxName, listSandboxes);
      if (!process.env.CHAT_UI_URL && registeredPort !== null) {
        process.env.CHAT_UI_URL = `http://127.0.0.1:${String(registeredPort)}`;
      }
    }
    return ensureAgentDashboardForward(sandboxName, agent, {
      revalidateSandboxIdentity,
      ...(mayReuseForward ? { reuseExistingForward: true } : {}),
      beforeForwardPort: portReservation
        ? (port) => portReservation.releaseBeforeForward(agent.name, port)
        : undefined,
    });
  }

  async function ensureAgentFixedForward(
    sandboxName: string,
    port: number,
    label: string,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<boolean> {
    const gatewayName = resolveForwardServiceGateway(sandboxName, {
      revalidateSandboxIdentity,
    });
    try {
      if (!gatewayName) {
        throw new Error(`ForwardTcp authority is unavailable for '${sandboxName}'`);
      }
      revalidateSandboxIdentity?.(
        `start ${label} forward ${String(port)} for sandbox '${sandboxName}'`,
      );
      const authority = getForwardRuntimeAuthority(sandboxName, gatewayName);
      await reconcileForward(
        sandboxName,
        authority,
        forwardIdentity(sandboxName, authority, port, "loopback"),
        label,
        revalidateSandboxIdentity,
      );
      return true;
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      console.warn(`! ${label} forward on port ${port} did not start: ${diagnostic.slice(0, 240)}`);
      console.warn(
        `  Reconnect after resolving the issue: ${deps.cliName()} ${sandboxName} connect`,
      );
      return false;
    }
  }

  /**
   * Read a bearer_token agent's web-auth token (e.g. Hermes' API_SERVER_KEY)
   * from its in-sandbox .env. The .env is 0640 root:sandbox and the gateway
   * group can read it, so we grep it via `sandbox exec` as the sandbox user
   * rather than `sandbox download` (which may not have read access). Prints
   * only the value, never the key name, and returns null when the agent has
   * no bearer token or the value is absent.
   */
  function fetchAgentWebAuthTokenFromSandbox(
    sandboxName: string,
    agent: AgentDefinition,
  ): string | null {
    return fetchAgentWebAuthToken(deps.runCaptureOpenshell, sandboxName, agent);
  }

  async function fetchGatewayAuthTokenFromSandbox(sandboxName: string): Promise<string | null> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-token-"));
    let completion: Awaited<ReturnType<OpenShellSandboxTransferExecutor["run"]>> | undefined;
    let token: string | null = null;
    try {
      const destDir = `${tmpDir}${path.sep}`;
      completion = await (
        deps.sandboxTransferExecutor ?? createCliOpenShellSandboxTransferExecutor()
      ).run({
        direction: "download",
        sandboxName,
        target: { kind: "selected" },
        source: "/sandbox/.openclaw/openclaw.json",
        destination: destDir,
        output: "suppress",
      });
      if (completion.outcome.kind !== "completed" || completion.outcome.exitCode !== 0) return null;
      if (completion.wasInterrupted()) return null;
      const jsonPath = findOpenclawJsonPath(tmpDir);
      if (!jsonPath) return null;
      const cfg = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const parsedToken = cfg && cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
      token = typeof parsedToken === "string" && parsedToken.length > 0 ? parsedToken : null;
    } catch {
      token = null;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      if (completion?.wasInterrupted()) token = null;
      completion?.release();
    }
    return token;
  }

  /**
   * Print the terminal handoff for a ready sandbox. `launch` runs the same
   * preflight as `connect` and then starts the agent (#6006), so it leads. The
   * `connect` path stays documented for anyone who wants a sandbox shell, and
   * the command it tells the user to run comes from the agent manifest rather
   * than a hardcoded `openclaw tui`.
   */
  function printTerminalHandoff(
    indent: string,
    sandboxName: string,
    agent: AgentDefinition | null,
  ): void {
    console.log(`${indent}Terminal:`);
    console.log(`${indent}  ${deps.cliName()} launch ${sandboxName}`);
    console.log("");
    console.log(`${indent}  Or open a sandbox shell first:`);
    console.log(`${indent}    ${deps.cliName()} ${sandboxName} connect`);
    void getInteractiveAgentCommand(agent, agent?.name);
    console.log(`${indent}    then run the configured interactive agent command`);
  }

  async function printDashboard(
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null = null,
    agent: AgentDefinition | null = null,
    ready = true,
  ): Promise<void> {
    const nimStatus = deps.nimStatus ?? nim.nimStatus;
    const nimStatusByName = deps.nimStatusByName ?? nim.nimStatusByName;
    const shouldShowNimLine = deps.shouldShowNimLine ?? nim.shouldShowNimLine;
    const nimStat = nimContainer ? nimStatusByName(nimContainer) : nimStatus(sandboxName);
    const showNim = shouldShowNimLine(nimContainer, nimStat.running);
    const nimLabel = nimStat.running ? "running" : "not running";
    const providerLabel = deps.getProviderLabel(provider);
    const token =
      !agent || agent.dashboard.auth === "url_token"
        ? await fetchGatewayAuthTokenFromSandbox(sandboxName)
        : null;
    const chatUiUrl = process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
    const chain = buildChain({
      chatUiUrl,
      ...dashboardAccess.resolveDashboardPlatformHints({
        isWsl: deps.isWsl(),
        runCapture: deps.runCapture,
      }),
    });
    const dashboardBaseUrl = `${chain.accessUrl.replace(/\/$/, "")}/`;
    const dashboardUrl = dashboardUrlForDisplay(
      dashboardAccess.buildAuthenticatedDashboardUrl(dashboardBaseUrl, token),
      deps,
    );
    const fallbackDashboardUrls = chain.fallbackUrls.map((fallback) =>
      dashboardUrlForDisplay(
        dashboardAccess.buildAuthenticatedDashboardUrl(`${fallback.replace(/\/$/, "")}/`, token),
        deps,
      ),
    );

    console.log("");
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  ${deps.agentProductName()} is ${ready ? "ready" : "not ready"}`);
    console.log("");
    console.log(`  Sandbox:  ${sandboxName}`);
    console.log(`  Model:    ${model} (${providerLabel})`);
    if (showNim) {
      console.log(`  NIM:      ${nimLabel}`);
    }
    console.log("");
    if (agent) {
      console.log("  Access");
      console.log("");
      deps.printAgentDashboardUi(sandboxName, token, agent, {
        note: deps.note,
        effectiveDashboardPort: chain.port,
        buildControlUiUrls: (tokenValue: string | null, port: number) => {
          const primary = buildControlUiUrls(tokenValue, port);
          const alternates = buildFallbackControlUiUrls(tokenValue, port, [
            chain.accessUrl,
            ...chain.fallbackUrls,
          ]);
          return [...new Set([...primary, ...alternates])];
        },
      });
      console.log("");
      printTerminalHandoff("  ", sandboxName, agent);
    } else if (token) {
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      printWslFallback(fallbackDashboardUrls, "    ");
      console.log("");
      printTerminalHandoff("    ", sandboxName, agent);
      console.log("");
      console.log("  Authenticated dashboard URL, if needed:");
      console.log(`    ${deps.cliName()} ${sandboxName} dashboard-url --quiet`);
    } else {
      deps.note("  Could not read gateway token from the sandbox (download failed).");
      console.log("  Start chatting");
      console.log("");
      console.log("    Browser:");
      console.log(`      ${dashboardUrl}`);
      printWslFallback(fallbackDashboardUrls, "    ");
      console.log("");
      printTerminalHandoff("    ", sandboxName, agent);
    }
    const sshForwardHint = buildSshForwardHintLines({
      port: chain.port,
      accessUrl: chain.accessUrl,
      env: deps.env,
    });
    if (sshForwardHint) {
      console.log("");
      for (const line of sshForwardHint) {
        console.log(line);
      }
    }
    console.log("");
    console.log("  Manage later");
    console.log("");
    console.log(`    Status:      ${deps.cliName()} ${sandboxName} status`);
    console.log(`    Logs:        ${deps.cliName()} ${sandboxName} logs --follow`);
    console.log(
      `    Model:       ${deps.cliName()} inference set --model <model> --provider <provider> --sandbox ${sandboxName}`,
    );
    console.log(`    Policies:    ${deps.cliName()} ${sandboxName} policy add`);
    console.log(
      `    Credentials: ${deps.cliName()} credentials reset <PROVIDER> && ${deps.cliName()} onboard`,
    );
    console.log(`  ${"─".repeat(50)}`);
    console.log("");
  }

  return {
    buildChain,
    buildAgentVerifyChain,
    buildControlUiUrls,
    buildOrphanedSandboxRollbackMessage,
    ensureDashboardForward,
    ensureAgentDashboardForward,
    ensureFinalizationAgentDashboardForward,
    ensureFinalizationDashboardForward,
    ensureAgentFixedForward,
    fetchGatewayAuthTokenFromSandbox,
    fetchAgentWebAuthTokenFromSandbox,
    createForwardPortObserver,
    getDashboardForwardPort,
    getDashboardForwardTarget,
    printDashboard,
    stopAllDashboardForwards,
  };
}

const HOST_PROBE_MAX_SECONDS = "3";

/**
 * Probe a dashboard-chain port on the host through its forward, for the
 * onboarding deployment verification. Returns the HTTP status, or 0 when the
 * forward is down.
 */
export function probeVerificationHostPort(port: number, probePath: string): number {
  const result = defaultRunCapture(
    [
      "curl",
      "-so",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      HOST_PROBE_MAX_SECONDS,
      `http://127.0.0.1:${port}${probePath}`,
    ],
    { ignoreError: true },
  );
  return parseInt(result.trim(), 10) || 0;
}
