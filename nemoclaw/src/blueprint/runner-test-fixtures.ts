// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  return resultWithBlueprintPolicyAuthority(
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

/** OpenShell 0.0.106 output when no global policy revision exists. */
export function absentGlobalPolicyHistoryResult(): CommandResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "No global policy history found\n",
  };
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
export function sandboxPolicyAuthorityResult(
  sandboxName: string,
  authority: "nemoclaw-managed" | "externally-managed" = "nemoclaw-managed",
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
      policy_source: authority === "nemoclaw-managed" ? "sandbox" : "global",
      hash: policyHash,
      active_version: policyVersion,
      policy: effectivePolicy,
    }),
    stderr: "",
  };
}

/** Machine-readable external global policy metadata. */
export function globalPolicyAuthorityResult(
  networkPolicies: Record<string, unknown> = {},
): CommandResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "global",
      status: "loaded",
      policy_source: "global",
      hash: "sha256:global-policy",
      active_version: 1,
      policy: { version: 1, network_policies: networkPolicies },
    }),
    stderr: "",
  };
}

/** Standard gateway and policy-authority responses for blueprint apply tests. */
export function resultWithBlueprintPolicyAuthority(
  args: readonly string[],
  fallback: CommandResult,
  gateway = "test-gateway",
): CommandResult {
  return args.join(" ") === "status"
    ? gatewayStatusResult(gateway)
    : args.join(" ") === `gateway info -g ${gateway}`
      ? gatewayInfoResult()
      : args.join(" ") === `policy list -g ${gateway} --global --limit 1`
        ? absentGlobalPolicyHistoryResult()
        : args[0] === "policy" &&
            args[1] === "get" &&
            args[2] === "-g" &&
            args[3] === gateway &&
            args[4] === "--full" &&
            args[5] === "--output" &&
            args[6] === "json" &&
            typeof args[7] === "string"
          ? sandboxPolicyAuthorityResult(args[7])
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
      return sandboxPolicyAuthorityResult(
        "test-sandbox",
        "nemoclaw-managed",
        (livePolicy.network_policies as Record<string, unknown> | undefined) ?? {},
        livePolicy,
        livePolicyHash,
        livePolicyVersion,
      );
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
    return resultWithBlueprintPolicyAuthority(args, successResult());
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

/** A `settings get` payload with gateway providers v2 enabled. */
export function providersV2EnabledResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "global",
      settings_revision: 1,
      settings: { providers_v2_enabled: "true" },
    }),
    stderr: "",
  };
}
