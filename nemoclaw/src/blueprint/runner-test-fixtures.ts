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
  return resultWithSandboxPolicyAuthority(
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

type CommandResult = { exitCode: number; stdout: string; stderr: string };

/** Stateful gateway-route behavior layered over a suite's ordinary command result. */
export function createInferenceRouteResult(
  gateway: string,
  initial: { provider: string; model: string; timeoutSeconds: number } | null = {
    provider: "prior-provider",
    model: "prior-model",
    timeoutSeconds: 45,
  },
): (args: readonly string[], fallback: CommandResult) => CommandResult {
  let active = initial === null ? null : { ...initial };
  return (args, fallback) => {
    if (args.join(" ") === `inference get -g ${gateway}`) {
      return {
        exitCode: 0,
        stdout:
          active === null
            ? "Gateway inference:\n\n  Not configured\n"
            : [
                "Gateway inference:",
                "",
                `  Provider: ${active.provider}`,
                `  Model: ${active.model}`,
                `  Timeout: ${String(active.timeoutSeconds)}s`,
                "",
              ].join("\n"),
        stderr: "",
      };
    }
    if (
      fallback.exitCode === 0 &&
      args[0] === "inference" &&
      args[1] === "set" &&
      args[2] === "-g" &&
      args[3] === gateway
    ) {
      const providerIndex = args.indexOf("--provider");
      const modelIndex = args.indexOf("--model");
      const timeoutIndex = args.indexOf("--timeout");
      active = {
        provider: args[providerIndex + 1] ?? "",
        model: args[modelIndex + 1] ?? "",
        timeoutSeconds: timeoutIndex < 0 ? 180 : Number(args[timeoutIndex + 1]),
      };
    }
    if (
      fallback.exitCode === 0 &&
      args.join(" ") === `inference delete -g ${gateway}`
    ) {
      active = null;
    }
    return fallback;
  };
}

/** Route-aware command result with the standard runner policy/status metadata. */
export function createRunnerCommandResult() {
  const inferenceResult = createInferenceRouteResult("test-gateway");
  return (args: readonly string[], fallback: CommandResult): CommandResult =>
    resultWithSandboxPolicyAuthority(args, inferenceResult(args, fallback));
}

/** OpenShell v0.0.106 global history result when no policy revision exists. */
export function globalPolicyAbsentResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** OpenShell v0.0.106 global history result when at least one revision exists. */
export function globalPolicyHistoryResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 0, stdout: "VERSION STATUS\n1 loaded\n", stderr: "" };
}

/** A failed command result carrying only stderr. */
export function failureResult(stderr: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return { exitCode: 1, stdout: "", stderr };
}

/** The connected gateway identity reported by `openshell status`. */
export function gatewayStatusResult(gateway = "test-gateway"): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 0,
    stdout: ["Gateway Status", "", "  Status: Connected", `  Gateway: ${gateway}`, ""].join("\n"),
    stderr: "",
  };
}

/** Results for a successful route replacement after sandbox-create reports reuse. */
export function reusedSandboxApplyResultQueue(provider: string, model: string) {
  const routeResults = [
    "Gateway inference:\n\n  Provider: prior-provider\n  Model: prior-model\n  Timeout: 45s\n",
    "Gateway inference:\n\n  Provider: prior-provider\n  Model: prior-model\n  Timeout: 45s\n",
    [
      "Gateway inference:",
      "",
      `  Provider: ${provider}`,
      `  Model: ${model}`,
      "  Version: 1",
      "  Timeout: 180s",
      "",
    ].join("\n"),
  ].map((stdout) => ({ exitCode: 0, stdout, stderr: "" }));
  return (args: readonly string[]) =>
    args.join(" ") === "status"
      ? gatewayStatusResult()
      : args.slice(0, 4).join(" ") === "sandbox get -g test-gateway"
        ? { exitCode: 0, stdout: `Name: ${args[4]}\nPhase: Ready`, stderr: "" }
        : args.join(" ") === "inference get -g test-gateway"
          ? (routeResults.shift() ?? failureResult("route response queue exhausted"))
          : resultForCommandFailure(args, ["sandbox", "create"], "already exists");
}

/** Machine-readable effective policy metadata for one sandbox. */
export function sandboxPolicyAuthorityResult(
  sandboxName: string,
  authority: "nemoclaw-managed" | "externally-managed" = "nemoclaw-managed",
  networkPolicies: Record<string, unknown> = {},
): { exitCode: number; stdout: string; stderr: string } {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "sandbox",
      sandbox: sandboxName,
      status: "effective",
      policy_source: authority === "nemoclaw-managed" ? "sandbox" : "global",
      policy: { version: 1, network_policies: networkPolicies },
    }),
    stderr: "",
  };
}

/** Machine-readable external global policy metadata. */
export function globalPolicyAuthorityResult(networkPolicies: Record<string, unknown> = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "global",
      status: "loaded",
      policy_source: "global",
      policy: { version: 1, network_policies: networkPolicies },
    }),
    stderr: "",
  };
}

/** Machine-readable latest global policy metadata after policy deletion. */
export function globalPolicySupersededResult(): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      scope: "global",
      status: "superseded",
      policy_source: "global",
    }),
    stderr: "",
  };
}

/** Replace a fallback result for a machine-readable sandbox policy query. */
export function resultWithSandboxPolicyAuthority(
  args: readonly string[],
  fallback: { exitCode: number; stdout: string; stderr: string },
): { exitCode: number; stdout: string; stderr: string } {
  return args.join(" ") === "status"
    ? gatewayStatusResult()
    : args[0] === "sandbox" && args[1] === "get" && args[2] === "-g"
      ? { exitCode: 0, stdout: `Name: ${args[4]}\nPhase: Ready`, stderr: "" }
      : args.join(" ") === "policy list -g test-gateway --global --limit 1"
        ? globalPolicyAbsentResult()
        : args[0] === "policy" &&
            args[1] === "get" &&
            args[2] === "-g" &&
            args[3] === "test-gateway" &&
            args[4] === "--full" &&
            args[5] === "--output" &&
            args[6] === "json" &&
            typeof args[7] === "string" &&
            !args[7].startsWith("--")
          ? sandboxPolicyAuthorityResult(args[7])
          : fallback;
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
