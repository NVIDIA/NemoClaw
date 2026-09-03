// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { checkOpenAiInferenceProviderProfile } from "../../../adapters/openshell/provider-profile-registration";
import { cloneAndDeepFreeze } from "../../../core/immutable";
import {
  getHermesToolGatewayCloneBroker,
  type HermesToolGatewayCloneBroker,
} from "../../../hermes-tool-gateway-clone-broker";
import type { PreparedManagedWorkloadCloneHandoff } from "../../../onboard/workload/clone";
import type { SandboxEntry } from "../../../state/registry/types";
import * as sandboxState from "../../../state/sandbox";
import {
  cleanupManagedCloneProviderTransaction,
  type ManagedCloneProviderBinding,
  type ManagedCloneProviderCleanupResult,
  MANAGED_CLONE_PROVIDER_CREATE_TIMEOUT_MS,
  type ManagedCloneProviderRunner,
  type ManagedCloneProviderTransactionReceipt,
  type PreparedManagedCloneProviderTransaction,
  prepareManagedCloneProviderTransaction,
  provisionManagedCloneProviderTransaction,
  revalidateManagedCloneMutationAuthority,
} from "./managed-clone-providers";

export const HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV =
  "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";
export const HERMES_INFERENCE_CREDENTIAL_ENV = "OPENAI_API_KEY";

type ReadSandbox = (sandboxName: string) => SandboxEntry | null;
type CaptureSnapshotRestoreAuthority = typeof sandboxState.captureSnapshotRestoreAuthority;
type HermesCloneHandoff = Pick<
  PreparedManagedWorkloadCloneHandoff,
  | "destinationSandboxName"
  | "messaging"
  | "providerId"
  | "rebound"
  | "snapshotRestoreAuthority"
  | "sourceRegistryAuthority"
  | "sourceSandboxName"
>;

export interface PreparedHermesManagedCloneBrokerTransaction {
  readonly schemaVersion: 1;
  readonly phase: "prepared";
  readonly gatewayProviderName: string;
  readonly inferenceProviderName: string;
  readonly providerTransaction: PreparedManagedCloneProviderTransaction;
}

export interface HermesManagedCloneBrokerReceipt {
  readonly schemaVersion: 1;
  readonly phase: "activated";
  readonly destinationSandboxName: string;
  readonly providerReceipt: ManagedCloneProviderTransactionReceipt;
}

export class HermesManagedCloneBrokerTransactionError extends Error {
  readonly providerReceipt?: ManagedCloneProviderTransactionReceipt;
  readonly cleanup?: ManagedCloneProviderCleanupResult;
  readonly cleanupDeferred: boolean;

  constructor(
    message: string,
    options: ErrorOptions & {
      readonly providerReceipt?: ManagedCloneProviderTransactionReceipt;
      readonly cleanup?: ManagedCloneProviderCleanupResult;
      readonly cleanupDeferred?: boolean;
    } = {},
  ) {
    super(`Hermes managed clone broker transaction failed: ${message}`, options);
    this.name = "HermesManagedCloneBrokerTransactionError";
    this.providerReceipt = options.providerReceipt;
    this.cleanup = options.cleanup;
    this.cleanupDeferred = options.cleanupDeferred ?? false;
  }
}

function hermesEnabled(handoff: HermesCloneHandoff): boolean {
  const profile = handoff.rebound.profile;
  return profile.agent === "hermes" && profile.tools.enabledGateways.length > 0;
}

/**
 * Resolve apply-only Hermes credentials. Device-code OAuth is never selected
 * implicitly: a caller must opt in and inject the exact flow it intends to run.
 */
export async function resolveHermesManagedCloneCredentialEnvironment(input: {
  readonly handoff: HermesCloneHandoff;
  readonly environment?: NodeJS.ProcessEnv;
  readonly allowDeviceCodeFlow?: boolean;
  readonly runDeviceCodeFlow?: () => Promise<{ readonly refresh_token?: string }>;
}): Promise<NodeJS.ProcessEnv> {
  if (!hermesEnabled(input.handoff)) return {};
  const environment = input.environment ?? process.env;
  let refreshToken = environment[HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]
    ?.replace(/\r/gu, "")
    .trim();
  if (!refreshToken && input.allowDeviceCodeFlow === true) {
    if (!input.runDeviceCodeFlow) {
      throw new Error("explicit Hermes device-code flow selection requires an injected runner");
    }
    const tokens = await input.runDeviceCodeFlow();
    refreshToken = tokens.refresh_token?.replace(/\r/gu, "").trim();
  }
  if (!refreshToken) {
    throw new Error(
      "managed Hermes tool-gateway clone requires an explicit Nous refresh credential; " +
        `export ${HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV} before retrying`,
    );
  }
  return {
    [HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]: refreshToken,
    [HERMES_INFERENCE_CREDENTIAL_ENV]: `nc_clone_${randomBytes(32).toString("base64url")}`,
  };
}

function hermesBindings(
  destinationSandboxName: string,
  broker: HermesToolGatewayCloneBroker,
): readonly ManagedCloneProviderBinding[] {
  if (
    broker.HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV !== HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV
  ) {
    throw new Error("Hermes managed-tool gateway credential contract changed");
  }
  return [
    {
      providerName: broker.getHermesInferenceProviderName(destinationSandboxName),
      providerType: "openai",
      providerEnvKey: HERMES_INFERENCE_CREDENTIAL_ENV,
      source: "hermes-inference",
    },
    {
      providerName: broker.getHermesToolGatewayProviderName(destinationSandboxName),
      providerType: "generic",
      providerEnvKey: HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV,
      source: "hermes-tool-gateway",
    },
  ];
}

function destinationHermesBindings(
  destination: Readonly<SandboxEntry>,
  broker: HermesToolGatewayCloneBroker,
): readonly ManagedCloneProviderBinding[] {
  if (
    destination.agent !== "hermes" ||
    !destination.hermesToolGateways?.length ||
    destination.hermesInferenceProvider !== broker.getHermesInferenceProviderName(destination.name)
  ) {
    return [];
  }
  return hermesBindings(destination.name, broker);
}

export function prepareHermesManagedCloneBrokerTransaction(input: {
  readonly handoff: HermesCloneHandoff;
  readonly destination: SandboxEntry | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runOpenshell: ManagedCloneProviderRunner;
  readonly broker?: HermesToolGatewayCloneBroker;
  readonly transactionId?: string;
}): PreparedHermesManagedCloneBrokerTransaction {
  if (!hermesEnabled(input.handoff)) {
    throw new Error("Hermes managed-tool broker preparation requires an enabled Hermes gateway");
  }
  const broker = input.broker ?? getHermesToolGatewayCloneBroker();
  const destinationSandboxName = input.handoff.destinationSandboxName;
  broker.preflightHermesToolGatewayCloneBinding(destinationSandboxName);
  const bindings = hermesBindings(destinationSandboxName, broker);
  const providerTransaction = prepareManagedCloneProviderTransaction({
    handoff: input.handoff,
    destination: input.destination,
    additionalBindings: bindings,
    resolveAdditionalDestinationOwnedBindings: (destination) =>
      destinationHermesBindings(destination, broker),
    environment: input.environment,
    runOpenshell: input.runOpenshell,
    transactionId: input.transactionId,
  });
  return cloneAndDeepFreeze({
    schemaVersion: 1 as const,
    phase: "prepared" as const,
    gatewayProviderName: bindings[1].providerName,
    inferenceProviderName: bindings[0].providerName,
    providerTransaction,
  });
}

function isUnknownActivationOutcome(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "hermes_clone_activation_outcome_unknown"
  );
}

function ensureHermesCloneInferenceProviderProfile(runOpenshell: ManagedCloneProviderRunner): void {
  const profile = checkOpenAiInferenceProviderProfile({
    runOpenshell: (args, options) =>
      runOpenshell(args, {
        ...options,
        timeout: MANAGED_CLONE_PROVIDER_CREATE_TIMEOUT_MS,
      }),
  });
  if (profile.ok) return;
  throw new HermesManagedCloneBrokerTransactionError(profile.messages.join("\n"));
}

export function provisionHermesManagedCloneBrokerTransaction(
  prepared: PreparedHermesManagedCloneBrokerTransaction,
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly runOpenshell: ManagedCloneProviderRunner;
    readonly readSandbox: ReadSandbox;
    readonly captureSnapshotRestoreAuthority?: CaptureSnapshotRestoreAuthority;
    readonly broker?: HermesToolGatewayCloneBroker;
  },
): HermesManagedCloneBrokerReceipt {
  const broker = input.broker ?? getHermesToolGatewayCloneBroker();
  const environment = input.environment ?? process.env;
  const refreshToken = environment[HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV]
    ?.replace(/\r/gu, "")
    .trim();
  if (!refreshToken) {
    throw new HermesManagedCloneBrokerTransactionError(
      `credential ${HERMES_TOOL_GATEWAY_REFRESH_CREDENTIAL_ENV} disappeared before broker staging`,
    );
  }

  revalidateManagedCloneMutationAuthority(prepared.providerTransaction, input);
  ensureHermesCloneInferenceProviderProfile(input.runOpenshell);
  let staged: ReturnType<HermesToolGatewayCloneBroker["stageHermesToolGatewayCloneBinding"]>;
  try {
    staged = broker.stageHermesToolGatewayCloneBinding(
      prepared.providerTransaction.destinationSandboxName,
      refreshToken,
      { requestId: `nc_clone_${prepared.providerTransaction.transactionId}` },
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HermesManagedCloneBrokerTransactionError(
      `${detail}; no destination provider mutation was attempted`,
      { cause },
    );
  }
  let providerReceipt: ManagedCloneProviderTransactionReceipt | undefined;
  try {
    providerReceipt = provisionManagedCloneProviderTransaction(prepared.providerTransaction, {
      ...input,
      environment,
      resolveCredential: (binding, applyEnvironment) =>
        binding.providerName === prepared.gatewayProviderName
          ? staged.brokerToken
          : applyEnvironment[binding.providerEnvKey],
    });
    revalidateManagedCloneMutationAuthority(prepared.providerTransaction, input);
    broker.activateHermesToolGatewayCloneBinding(
      prepared.providerTransaction.destinationSandboxName,
      refreshToken,
      staged,
    );
    return cloneAndDeepFreeze({
      schemaVersion: 1 as const,
      phase: "activated" as const,
      destinationSandboxName: prepared.providerTransaction.destinationSandboxName,
      providerReceipt,
    });
  } catch (cause) {
    if (isUnknownActivationOutcome(cause) && providerReceipt) {
      throw new HermesManagedCloneBrokerTransactionError(
        "activation outcome is unknown; preserving providers and broker state for reconciliation",
        { cause, providerReceipt, cleanupDeferred: true },
      );
    }
    const cleanup = providerReceipt
      ? cleanupManagedCloneProviderTransaction(providerReceipt, input.runOpenshell)
      : undefined;
    let discarded = false;
    try {
      discarded = broker.discardHermesToolGatewayCloneBinding(
        prepared.providerTransaction.destinationSandboxName,
        staged,
      );
    } catch {
      discarded = false;
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new HermesManagedCloneBrokerTransactionError(
      `${detail}; broker staging ${discarded ? "discarded" : "could not be proven discarded"}`,
      { cause, providerReceipt, cleanup },
    );
  }
}
