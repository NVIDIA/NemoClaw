// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { defaultRun } from "../../adapters/uninstall/commands";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import { providerDeleteSkipMessage } from "../../domain/uninstall/messaging";

export { defaultRun, defaultRunDocker, type RunResult } from "../../adapters/uninstall/commands";

export async function deleteUninstallProviders(
  providers: readonly string[],
  runtime: {
    env: NodeJS.ProcessEnv;
    run: typeof defaultRun;
    log: (message: string) => void;
    warn: (message: string) => void;
  },
): Promise<void> {
  const adapter = createManagedProviderAdapter(
    (args, options) => runtime.run("openshell", args, { ...options, env: runtime.env }),
    { environment: runtime.env },
  );
  for (const providerName of providers) {
    const result = await adapter.deleteProvider({ target: { kind: "selected" }, providerName });
    if (result.ok) runtime.log(`Deleted provider '${providerName}'`);
    else runtime.warn(providerDeleteSkipMessage(providerName));
  }
}
