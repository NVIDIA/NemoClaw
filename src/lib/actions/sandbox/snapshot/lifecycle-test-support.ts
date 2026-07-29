// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type TestCommandOptions = Record<string, unknown> | undefined;
export type TestCommandResult = {
  readonly status: number;
  readonly output: string;
  readonly stdout?: string;
  readonly stderr?: string;
};
type TestCommandRouteResult = Omit<TestCommandResult, "output"> & {
  readonly output?: string;
};
type TestCommandRoute = (args: string[], options?: TestCommandOptions) => TestCommandRouteResult;
export type TestCommandHandler = (
  args: string[],
  options?: TestCommandOptions,
) => TestCommandResult;

const SUCCESSFUL_COMMAND: TestCommandResult = { status: 0, output: "" };
const MISSING_COMMAND: TestCommandResult = {
  status: 1,
  stdout: "",
  stderr: "",
  output: "",
};

export function providerMetadata(name: string, type: string, credentialEnv: string): string {
  return [
    `Name: ${name}`,
    `Type: ${type}`,
    `Credential keys: ${credentialEnv}`,
    "Config keys: <none>",
    "",
  ].join("\n");
}

export function valueByName<T>(values: Readonly<Record<string, T>>): (name?: string) => T | null {
  return (name) => {
    if (name === undefined) return null;
    return values[name] ?? null;
  };
}

export function valueFactoryByName<T>(
  values: Readonly<Record<string, () => T | null>>,
): (name?: string) => T | null {
  return (name) => {
    if (name === undefined) return null;
    return values[name]?.() ?? null;
  };
}

export function commandRouter(
  routes: Readonly<Record<string, TestCommandRoute>>,
  fallback: TestCommandRoute = () => SUCCESSFUL_COMMAND,
): TestCommandHandler {
  return (args, options) => {
    const handler = routes[args.join(" ")] ?? fallback;
    return { output: "", ...handler(args, options) };
  };
}

export function recordingCommandRouter(
  calls: Array<{ args: string[]; options?: Record<string, unknown> }>,
  routes: Readonly<Record<string, TestCommandRoute>>,
): TestCommandHandler {
  const route = commandRouter(routes);
  return (args, options) => {
    calls.push({ args, options });
    return route(args, options);
  };
}

export function managedProviderCreationRunner(
  bindings: Readonly<Record<string, { readonly type: string; readonly credential: string }>>,
): TestCommandHandler {
  const createdProviders = new Set<string>();
  return (args) => {
    if (args[0] === "provider" && args[1] === "get") {
      const providerName = args[2] ?? "";
      const binding = bindings[providerName];
      return binding !== undefined && createdProviders.has(providerName)
        ? {
            status: 0,
            stdout: providerMetadata(providerName, binding.type, binding.credential),
            stderr: "",
            output: "",
          }
        : MISSING_COMMAND;
    }
    if (args[0] === "provider" && args[1] === "create") {
      createdProviders.add(args[3] ?? "");
      return { status: 0, stdout: "", stderr: "", output: "" };
    }
    return SUCCESSFUL_COMMAND;
  };
}

export function assertOpenClawDashboard(dashboard: {
  readonly agent: string;
}): asserts dashboard is {
  readonly agent: "openclaw";
  readonly port: number;
  readonly url: string;
} {
  if (dashboard.agent !== "openclaw") throw new Error("fixture mismatch");
}

export function createReplacementProviderHarness(
  validateCreateOptions: (options?: TestCommandOptions) => void,
): { readonly events: string[]; readonly runner: TestCommandHandler } {
  const events: string[] = [];
  let destinationProviderExists = true;
  const runner = commandRouter({
    "provider get beta-telegram-bridge": () =>
      destinationProviderExists
        ? {
            status: 0,
            stdout: providerMetadata("beta-telegram-bridge", "generic", "TELEGRAM_BOT_TOKEN"),
            stderr: "",
            output: "",
          }
        : MISSING_COMMAND,
    "sandbox provider detach beta beta-telegram-bridge": () => {
      events.push("detach");
      return SUCCESSFUL_COMMAND;
    },
    "sandbox delete beta": () => {
      events.push("sandbox-delete");
      return SUCCESSFUL_COMMAND;
    },
    "provider delete beta-telegram-bridge": () => {
      destinationProviderExists = false;
      events.push("provider-delete");
      return SUCCESSFUL_COMMAND;
    },
    "provider create --name beta-telegram-bridge --type generic --credential TELEGRAM_BOT_TOKEN": (
      _args,
      options,
    ) => {
      validateCreateOptions(options);
      destinationProviderExists = true;
      events.push("provider-create:new-clone-token");
      return SUCCESSFUL_COMMAND;
    },
  });
  return { events, runner };
}

export interface FailedReplacementProviderHarness {
  readonly events: string[];
  readonly runner: TestCommandHandler;
  markSandboxCreateFailed(): void;
  state(): {
    readonly destinationProviderExists: boolean;
    readonly partialSandboxExists: boolean;
  };
}

export function createFailedReplacementProviderHarness(
  validateCreateOptions: (options?: TestCommandOptions) => void,
): FailedReplacementProviderHarness {
  const events: string[] = [];
  let destinationProviderExists = true;
  let providerWasCreated = false;
  let partialSandboxExists = false;
  let providerAttached = true;
  let providerDeleteCount = 0;
  let sandboxDeleteCount = 0;
  let telegramDetachCount = 0;

  const runner = commandRouter({
    "provider get beta-telegram-bridge": () =>
      destinationProviderExists
        ? {
            status: 0,
            stdout: providerMetadata("beta-telegram-bridge", "generic", "TELEGRAM_BOT_TOKEN"),
            stderr: "",
            output: "",
          }
        : MISSING_COMMAND,
    "sandbox provider detach beta beta-telegram-bridge": () => {
      telegramDetachCount += 1;
      if (telegramDetachCount === 2) {
        events.push("partial-provider-detach:failed");
        return {
          status: 1,
          stderr: "synthetic transient detach failure",
          stdout: "",
          output: "",
        };
      }
      events.push(
        telegramDetachCount === 1
          ? "initial-provider-detach"
          : "rollback-provider-detach:recovered",
      );
      providerAttached = false;
      return SUCCESSFUL_COMMAND;
    },
    "sandbox delete beta": () => {
      sandboxDeleteCount += 1;
      if (sandboxDeleteCount === 1) {
        events.push("initial-sandbox-delete");
        return SUCCESSFUL_COMMAND;
      }
      events.push("partial-sandbox-delete:failed");
      return { status: 1, stderr: "synthetic partial delete failure", output: "" };
    },
    "provider delete beta-telegram-bridge": () => {
      providerDeleteCount += 1;
      if (!providerWasCreated && destinationProviderExists) {
        if (providerDeleteCount > 1 && !providerAttached) {
          destinationProviderExists = false;
          events.push("replacement-provider-delete");
          return SUCCESSFUL_COMMAND;
        }
        events.push("provider-delete:survived");
        return { status: 1, output: "" };
      }
      if (providerAttached) {
        events.push("provider-delete:blocked-attached");
        return {
          status: 1,
          stderr: "provider 'beta-telegram-bridge' is attached to sandbox(es): beta",
          stdout: "",
          output: "",
        };
      }
      destinationProviderExists = false;
      events.push("provider-delete:rollback");
      return SUCCESSFUL_COMMAND;
    },
    "provider create --name beta-telegram-bridge --type generic --credential TELEGRAM_BOT_TOKEN": (
      _args,
      options,
    ) => {
      validateCreateOptions(options);
      providerWasCreated = true;
      destinationProviderExists = true;
      events.push("provider-create:rotated-clone-token");
      return SUCCESSFUL_COMMAND;
    },
  });

  return {
    events,
    runner,
    markSandboxCreateFailed() {
      partialSandboxExists = true;
      providerAttached = true;
      events.push("sandbox-create:failed");
    },
    state: () => ({ destinationProviderExists, partialSandboxExists }),
  };
}
