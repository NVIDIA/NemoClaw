// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { actionApply, BlueprintNativeInferenceCreator } from "./runner.js";

/** The host transaction is tested in native-provider/blueprint.test.ts; these fixtures own plugin ordering. */
export const createNativeInferenceFixture: BlueprintNativeInferenceCreator = async (input) => {
  const receipt = {
    schemaVersion: 1,
    gatewayName: input.gatewayName,
    sandboxName: input.sandboxName,
    provider: input.provider,
    model: input.model,
    api: input.api,
    endpointUrl: input.endpointUrl,
    createAttemptNonce: "a".repeat(62),
    credentialEnv: input.credentialValue ? "OPENAI_API_KEY" : null,
    providerAttachment: {
      schemaVersion: 1,
      profileId: "test-native-profile",
      providerName: input.provider,
      providerId: "test-native-provider-id",
    },
  };
  input.persist({ ...receipt, providerAttachment: undefined });
  await input.createSandbox(input.provider, receipt.createAttemptNonce);
  const completed = { ...receipt, sandboxId: "sandbox-id-1" };
  input.persist({ ...completed, providerAttachment: undefined });
  await input.prepareSandboxPolicy();
  input.persist(completed);
  const identity = JSON.stringify(completed);
  return { identity, observe: async () => identity };
};

export function withNativeInferenceFixture(
  apply: typeof actionApply,
  creator: BlueprintNativeInferenceCreator = createNativeInferenceFixture,
): typeof actionApply {
  return (profile, blueprint, options) =>
    apply(profile, blueprint, {
      nativeInferenceCreator: creator,
      ...options,
    });
}

/** The smallest valid blueprint: one inference profile, one sandbox, empty policy. */
export function minimalBlueprint(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
    ...overrides,
  };
}

/** A valid blueprint routed through the local router profile. */
export function routedBlueprint(): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          routed: {
            provider_type: "openai",
            provider_name: "nvidia-router",
            endpoint: "http://localhost:4000/v1",
            model: "routed",
            credential_env: "NVIDIA_INFERENCE_API_KEY",
            credential_default: "router-local",
            timeout_secs: 180,
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      router: {
        enabled: true,
        port: 4000,
        pool_config_path: "router/pool-config.yaml",
      },
      policy: { additions: {} },
    },
  };
}

/** minimalBlueprint with the given policy additions substituted in. */
export function blueprintWithPolicyAdditions(
  additions: Record<string, unknown>,
): Record<string, unknown> {
  const blueprint = minimalBlueprint();
  const components = blueprint.components as Record<string, unknown>;
  return {
    ...blueprint,
    components: {
      ...components,
      policy: { additions },
    },
  };
}

/** Fails the given two-word command with stderr; every other command succeeds. */
export function resultForCommandFailure(
  args: readonly string[],
  command: readonly [string, string],
  stderr: string,
): { exitCode: number; stdout: string; stderr: string } {
  return resultWithBlueprintPolicy(
    args,
    args[0] === command[0] && args[1] === command[1]
      ? { exitCode: 1, stdout: "", stderr }
      : { exitCode: 0, stdout: "", stderr: "" },
  );
}

/** An empty successful command result. */
export function successResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** The empty JSON history page returned by OpenShell 0.1.3. */
export function absentGlobalPolicyHistoryResult(): CommandResult {
  return absentGlobalPolicyResult();
}

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** The configured policy used by blueprint runner tests that create a sandbox. */
export const TEST_SANDBOX_POLICY_PATH = "/tmp/nemoclaw-test-policy.yaml";
export const TEST_SANDBOX_POLICY = "version: 1\nnetwork_policies: {}\n";

/** The connected gateway identity reported by `openshell status`. */
export function gatewayStatusResult(gateway = "test-gateway"): CommandResult {
  return {
    exitCode: 0,
    stdout: ["Gateway Status", "", "  Status: Connected", `  Gateway: ${gateway}`, ""].join("\n"),
    stderr: "",
  };
}

/** The stable endpoint binding reported by `openshell gateway info`. */
export function gatewayInfoResult(port = 8080, host = "127.0.0.1"): CommandResult {
  return {
    exitCode: 0,
    stdout: `Gateway endpoint: http://${host}:${port}\n`,
    stderr: "",
  };
}

/** The immutable identity and lifecycle state reported for one sandbox. */
export function sandboxIdentityResult(
  sandboxName: string,
  id = "sandbox-id-1",
  phase = "Ready",
): CommandResult {
  return {
    exitCode: 0,
    stdout: `Name: ${sandboxName}\nId: ${id}\nPhase: ${phase}\n`,
    stderr: "",
  };
}

/** Machine-readable effective policy metadata for one sandbox. */
export function sandboxPolicyResult(
  sandboxName: string,
  policySource: "sandbox" | "global" = "sandbox",
  networkPolicies: Record<string, unknown> = {},
  effectivePolicy: Record<string, unknown> = { version: 1, network_policies: networkPolicies },
  policyHash = "sha256:test-policy",
  policyVersion = 1,
): CommandResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "sandbox",
      sandbox: sandboxName,
      status: "effective",
      policy_source: policySource,
      hash: policyHash,
      active_version: policyVersion,
      policy: effectivePolicy,
    }),
    stderr: "",
  };
}

/** Machine-readable global policy metadata. */
export function globalPolicyResult(networkPolicies: Record<string, unknown> = {}): CommandResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "global",
      status: "loaded",
      hash: "sha256:global-policy",
      version: 1,
      policy: { version: 1, network_policies: networkPolicies },
    }),
    stderr: "",
  };
}

/** Standard gateway and policy responses for blueprint apply tests. */
export function resultWithBlueprintPolicy(
  args: readonly string[],
  fallback: CommandResult,
  gateway = "test-gateway",
): CommandResult {
  if (
    args[0] === "sandbox" &&
    args[1] === "get" &&
    args[2] !== "-g" &&
    fallback.stdout === "" &&
    fallback.stderr === ""
  )
    return failureResult("sandbox not found");
  return args.join(" ") === "status"
    ? gatewayStatusResult(gateway)
    : args.join(" ") === `gateway info -g ${gateway}`
      ? gatewayInfoResult()
      : args.join(" ") === `policy list -g ${gateway} --global --page-size 1 --output json`
        ? absentGlobalPolicyHistoryResult()
        : args[0] === "policy" &&
            args[1] === "get" &&
            args[2] === "-g" &&
            args[3] === gateway &&
            args[4] === "--full" &&
            args[5] === "--output" &&
            args[6] === "json" &&
            typeof args[7] === "string"
          ? sandboxPolicyResult(args[7])
          : args[0] === "sandbox" &&
              args[1] === "get" &&
              args[2] === "-g" &&
              args[3] === gateway &&
              typeof args[4] === "string"
            ? sandboxIdentityResult(args[4])
            : fallback;
}

/** Returns configured results for successive calls to one exact command. */
export function sequentialCommandResult(
  command: string,
  results: readonly CommandResult[],
): (args: readonly string[]) => CommandResult | undefined {
  let callCount = 0;
  return (args) => {
    if (args.join(" ") !== command) return undefined;
    const result = results[Math.min(callCount, results.length - 1)];
    callCount += 1;
    return result;
  };
}

/** Tracks the effective sandbox policy after a blueprint policy mutation. */
export function createMutableSandboxPolicyResult(
  readMergedPolicy: () => Record<string, unknown>,
): (args: readonly string[]) => CommandResult {
  let livePolicy: Record<string, unknown> = { version: 1, network_policies: {} };
  let livePolicyHash = "sha256:test-policy";
  let livePolicyVersion = 1;
  return (args) => {
    if (args[0] === "policy" && args[1] === "set") {
      livePolicy = readMergedPolicy();
      livePolicyHash = "sha256:updated-policy";
      livePolicyVersion = 2;
      return successResult();
    }
    if (args.join(" ") === "policy get -g test-gateway --full --output json test-sandbox") {
      return sandboxPolicyResult(
        "test-sandbox",
        "sandbox",
        (livePolicy.network_policies as Record<string, unknown> | undefined) ?? {},
        livePolicy,
        livePolicyHash,
        livePolicyVersion,
      );
    }
    if (args.join(" ") === "policy get -g test-gateway --base test-sandbox") {
      return { exitCode: 0, stdout: JSON.stringify(livePolicy), stderr: "" };
    }
    if (args[0] === "provider" && args[1] === "get" && typeof args[2] === "string") {
      return {
        exitCode: 0,
        stdout: [
          `Name: ${args[2]}`,
          "Type: openai",
          "Credential keys: OPENAI_API_KEY",
          "Config keys: OPENAI_BASE_URL",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    return resultWithBlueprintPolicy(args, successResult());
  };
}

/** Adds runtime-identity command responses to a mutable blueprint policy fixture. */
export function createMutableIdentityPolicyResult(options: {
  readonly readMergedPolicy: () => Record<string, unknown>;
  readonly runtimeProviderListing: string;
  readonly policyWriteFailure?: string;
}): (args: readonly string[]) => CommandResult {
  let runtimeProviderReads = 0;
  const policyResult = createMutableSandboxPolicyResult(options.readMergedPolicy);
  return (args) => {
    const command = args.join(" ");
    if (command === "policy list --global --page-size 1 --output json")
      return absentGlobalPolicyResult();
    if (command === "provider get test-provider") return failureResult("provider not found");
    if (command === "provider get acme-okta-runtime") {
      runtimeProviderReads += 1;
      return runtimeProviderReads === 1
        ? failureResult("provider not found")
        : { exitCode: 0, stdout: options.runtimeProviderListing, stderr: "" };
    }
    if (options.policyWriteFailure && args[0] === "policy" && args[1] === "set") {
      return failureResult(
        `Error: code: 'failed_precondition', message: '${options.policyWriteFailure}'`,
      );
    }
    return policyResult(args);
  };
}

/** A failed command result carrying only stderr. */
export function failureResult(stderr: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 1, stdout: "", stderr };
}

/** The `provider get` listing for the sandbox's matching runtime identity provider. */
export const MATCHING_RUNTIME_PROVIDER_LISTING = [
  "Name: acme-okta-runtime",
  "Type: okta-runtime-v1",
  "Credential keys: OKTA_ACCESS_TOKEN",
  "Config keys: <none>",
  "",
].join("\n");

/** The `provider get` listing for the blueprint's matching inference provider. */
export const MATCHING_INFERENCE_PROVIDER_LISTING = [
  "Name: test-provider",
  "Type: openai",
  "Credential keys: <none>",
  "Config keys: OPENAI_BASE_URL",
  "",
].join("\n");

/** The `inference get` listing for the gateway route the blueprint expects. */
export const MATCHING_INFERENCE_ROUTE_LISTING = [
  "Gateway inference:",
  "",
  "  Provider: test-provider",
  "  Model: test-model",
  "  Version: 1",
  "  Timeout: 180s",
  "",
].join("\n");

/** An empty page of global policy history from OpenShell 0.1.3. */
export function absentGlobalPolicyResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      revisions: [],
      next_page_token: "",
    }),
    stderr: "",
  };
}
