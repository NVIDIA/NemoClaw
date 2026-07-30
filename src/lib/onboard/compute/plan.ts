// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellGatewayLauncher = "nemoclaw" | "openshell";
export const OPEN_SHELL_COMPUTE_DRIVER_ENV = "NEMOCLAW_COMPUTE_DRIVER";
export const OPEN_SHELL_COMPUTE_DRIVER_REQUESTS = ["auto", "docker", "podman"] as const;
export type OpenShellComputeDriverRequest = (typeof OPEN_SHELL_COMPUTE_DRIVER_REQUESTS)[number];

/**
 * Keeps OpenShell driver identity separate from the component that launches
 * its gateway. A future driver does not inherit Docker lifecycle behavior
 * because NemoClaw launches its gateway.
 */
export interface OpenShellComputePlan {
  readonly driverName: string;
  readonly gatewayLauncher: OpenShellGatewayLauncher;
}

export type OpenShellComputePlanRegistry = Readonly<Record<string, OpenShellComputePlan>>;

export interface OpenShellComputeCapabilities {
  readonly hostLocalInference: boolean;
}

export type OpenShellComputeCapabilitiesRegistry = Readonly<
  Record<string, OpenShellComputeCapabilities>
>;

/**
 * Driver plans known to the internal selection seam. Registering a plan does
 * not expose a CLI selection; public wiring follows runtime qualification.
 */
export const CURRENT_OPEN_SHELL_COMPUTE_PLANS = {
  docker: {
    driverName: "docker",
    gatewayLauncher: "nemoclaw",
  },
  kubernetes: {
    driverName: "kubernetes",
    gatewayLauncher: "openshell",
  },
  podman: {
    driverName: "podman",
    gatewayLauncher: "nemoclaw",
  },
} as const satisfies OpenShellComputePlanRegistry;

export const CURRENT_OPEN_SHELL_COMPUTE_CAPABILITIES = {
  docker: { hostLocalInference: true },
  kubernetes: { hostLocalInference: true },
  podman: { hostLocalInference: true },
} as const satisfies OpenShellComputeCapabilitiesRegistry;

export interface ResolveOpenShellComputeSelectionInput {
  readonly requestedDriver?: string | null;
  readonly persistedDriver?: string | null;
  readonly autoPlan: OpenShellComputePlan;
}

export interface PersistedOpenShellComputeDriverEvidence {
  readonly source: string;
  readonly driverName?: string | null;
}

export class OpenShellComputeSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenShellComputeSelectionError";
  }
}

export function resolveOpenShellComputeDriverRequest(
  requested: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): OpenShellComputeDriverRequest {
  const fromFlag = requested?.trim();
  const fromEnvironment = environment[OPEN_SHELL_COMPUTE_DRIVER_ENV]?.trim();
  const candidate = (fromFlag || fromEnvironment || "auto").toLowerCase();
  if (!(OPEN_SHELL_COMPUTE_DRIVER_REQUESTS as readonly string[]).includes(candidate)) {
    throw new OpenShellComputeSelectionError(
      `${OPEN_SHELL_COMPUTE_DRIVER_ENV} and --compute-driver must be one of: ${OPEN_SHELL_COMPUTE_DRIVER_REQUESTS.join(", ")}.`,
    );
  }
  return candidate as OpenShellComputeDriverRequest;
}

/**
 * Collapse durable driver evidence before any runtime mutation. Multiple
 * durable records may describe the same sandbox while onboarding is being
 * resumed or rebuilt; disagreement is corruption, not a migration request.
 */
export function resolvePersistedOpenShellComputeDriver(
  evidence: readonly PersistedOpenShellComputeDriverEvidence[],
): string | null {
  const observed = evidence.flatMap(({ source, driverName }) => {
    const normalized = driverName?.trim();
    return normalized ? [{ source, driverName: normalized }] : [];
  });
  const distinctDrivers = new Set(observed.map(({ driverName }) => driverName));
  if (distinctDrivers.size <= 1) return observed[0]?.driverName ?? null;

  throw new OpenShellComputeSelectionError(
    `Conflicting persisted OpenShell compute drivers: ${observed
      .map(({ source, driverName }) => `${source}='${driverName}'`)
      .join(", ")}.`,
  );
}

/**
 * Resolve an internal driver request without changing an existing sandbox's
 * persisted driver. The plan registry is injectable so future drivers such as
 * MXC do not need Docker or Podman lifecycle behavior.
 */
export function resolveOpenShellComputeSelection(
  input: ResolveOpenShellComputeSelectionInput,
  plans: OpenShellComputePlanRegistry = CURRENT_OPEN_SHELL_COMPUTE_PLANS,
): OpenShellComputePlan {
  const requestedDriver = input.requestedDriver ?? "auto";
  const persistedDriver = input.persistedDriver ?? null;
  const driverName =
    requestedDriver === "auto" ? (persistedDriver ?? input.autoPlan.driverName) : requestedDriver;

  if (persistedDriver !== null && driverName !== persistedDriver) {
    throw new OpenShellComputeSelectionError(
      `Requested OpenShell compute driver '${driverName}' does not match existing sandbox driver '${persistedDriver}'.`,
    );
  }

  const plan = Object.hasOwn(plans, driverName) ? plans[driverName] : undefined;
  if (plan === undefined || plan.driverName !== driverName) {
    throw new OpenShellComputeSelectionError(
      `OpenShell compute driver '${driverName}' is not registered.`,
    );
  }
  return { ...plan };
}

/**
 * Compute/workload capabilities are independent from gateway lifecycle
 * ownership. Future drivers such as MXC must register their runtime behavior
 * explicitly instead of inheriting Docker behavior from a launcher choice.
 */
export function resolveOpenShellComputeCapabilities(
  plan: Pick<OpenShellComputePlan, "driverName">,
  capabilities: OpenShellComputeCapabilitiesRegistry = CURRENT_OPEN_SHELL_COMPUTE_CAPABILITIES,
): OpenShellComputeCapabilities {
  const resolved = Object.hasOwn(capabilities, plan.driverName)
    ? capabilities[plan.driverName]
    : undefined;
  if (!resolved) {
    throw new OpenShellComputeSelectionError(
      `OpenShell compute driver '${plan.driverName}' has no registered capability profile.`,
    );
  }
  return { ...resolved };
}

/**
 * Describes the behavior NemoClaw uses today. Driver selection will move behind
 * this seam without changing the existing Docker and Kubernetes paths first.
 */
export function resolveCurrentOpenShellComputePlan(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): OpenShellComputePlan {
  const managedDockerGateway = platform === "linux" || (platform === "darwin" && arch === "arm64");
  const driverName = managedDockerGateway ? "docker" : "kubernetes";

  return { ...CURRENT_OPEN_SHELL_COMPUTE_PLANS[driverName] };
}

export function usesManagedDockerGateway(
  plan: Pick<OpenShellComputePlan, "driverName" | "gatewayLauncher">,
): boolean {
  return plan.driverName === "docker" && plan.gatewayLauncher === "nemoclaw";
}
