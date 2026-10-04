// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MINIMUM_OPENCLAW_PLUGIN_API_VERSION = "2026.5.22";

type RegistrationState = {
  commands: unknown[];
  hookNames: string[];
  providers: unknown[];
  services: unknown[];
};

export function createMinimumOpenClawPluginApi(): {
  api: Record<string, unknown>;
  registrations: RegistrationState;
} {
  const registrations: RegistrationState = {
    commands: [],
    hookNames: [],
    providers: [],
    services: [],
  };
  const logger = {
    info: (_message: string) => undefined,
    warn: (_message: string) => undefined,
    error: (_message: string) => undefined,
    debug: (_message: string) => undefined,
  };

  return {
    api: {
      id: "nemoclaw-package-contract",
      name: "NemoClaw package contract",
      version: MINIMUM_OPENCLAW_PLUGIN_API_VERSION,
      config: {},
      pluginConfig: {},
      logger,
      registerCommand: (command: unknown) => registrations.commands.push(command),
      registerProvider: (provider: unknown) => registrations.providers.push(provider),
      registerService: (service: unknown) => registrations.services.push(service),
      resolvePath: (input: string) => input,
      on: (hookName: string) => registrations.hookNames.push(hookName),
    },
    registrations,
  };
}
