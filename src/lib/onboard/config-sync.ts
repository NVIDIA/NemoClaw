// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSelectionConfig } from "../inference/config";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";

export interface RunSandboxConfigSyncDeps {
  getSelectionConfig: () => ProviderSelectionConfig | null;
  runConnectScript: (sandboxName: string, scriptContent: string) => Promise<void>;
  managedProfileApplied?: boolean;
}

export interface NemoClawConfigSyncDeps {
  getProviderSelectionConfig(provider: string, model: string): ProviderSelectionConfig | null;
  sandboxCommandExecutor: OpenShellSandboxBufferedCommandExecutor;
}

const skipSandboxIdentityRevalidation = (_operation: string): void => undefined;

export function createNemoClawConfigSync(deps: NemoClawConfigSyncDeps) {
  return async function syncNemoClawConfigInSandbox(
    sandboxName: string,
    provider: string,
    model: string,
    revalidateSandboxIdentity: (operation: string) => void = skipSandboxIdentityRevalidation,
    managedProfileApplied = false,
  ): Promise<void> {
    await runSandboxConfigSync(sandboxName, {
      getSelectionConfig: () => deps.getProviderSelectionConfig(provider, model),
      managedProfileApplied,
      runConnectScript: async (name, scriptContent) => {
        revalidateSandboxIdentity(`synchronize OpenClaw config in sandbox '${name}'`);
        const result = await deps.sandboxCommandExecutor.runBuffered({
          sandboxName: name,
          target: selectedOpenShellGateway(),
          command: ["/bin/bash", "-s"],
          tty: false,
          input: scriptContent,
        });
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.outcome.kind === "failed") throw new Error(result.outcome.error.message);
        if (result.outcome.exitCode !== 0) {
          throw new Error(`OpenShell command failed (exit ${String(result.outcome.exitCode)})`);
        }
      },
    });
  };
}

// Write `~/.nemoclaw/config.json` inside the sandbox and initialize managed-profile
// session state when needed. Also replace the historical zero-byte placeholder
// that crashes the OpenClaw nemoclaw plugin's loadOnboardConfig. Fixes #3999.
export async function runSandboxConfigSync(
  sandboxName: string,
  deps: RunSandboxConfigSyncDeps,
): Promise<void> {
  const selectionConfig = deps.getSelectionConfig();
  if (!selectionConfig) return;
  const sandboxConfig = { ...selectionConfig, onboardedAt: new Date().toISOString() };
  const script = buildSandboxConfigSyncScript(sandboxConfig, deps.managedProfileApplied === true);
  await deps.runConnectScript(sandboxName, script);
}

export function buildSandboxConfigSyncScript(
  selectionConfig: ProviderSelectionConfig & { agent?: string; onboardedAt?: string },
  managedProfileApplied = false,
): string {
  // OpenClaw owns routing in openclaw.json. Other agents still consume their
  // selection snapshot for resume drift checks.
  const metadata =
    !selectionConfig.agent || selectionConfig.agent === "openclaw"
      ? { profile: selectionConfig.profile, onboardedAt: selectionConfig.onboardedAt }
      : selectionConfig;
  const writeSelection = `
set -euo pipefail
# OpenShell exec and the OpenClaw gateway can expose different HOME values.
# The managed gateway always reads its NemoClaw state from /sandbox.
nemoclaw_dir="/sandbox/.nemoclaw"
nemoclaw_config="$nemoclaw_dir/config.json"
mkdir -p -m 700 "$nemoclaw_dir"
nemoclaw_dir_uid="$(stat -c '%u' "$nemoclaw_dir" 2>/dev/null || echo '')"
current_uid="$(id -u 2>/dev/null || echo '')"
if [ -n "$nemoclaw_dir_uid" ] && [ "$nemoclaw_dir_uid" = "$current_uid" ]; then
  chmod 700 "$nemoclaw_dir"
fi
cat > "$nemoclaw_config" <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(metadata, null, 2)}
EOF_NEMOCLAW_CFG
chmod 600 "$nemoclaw_config"
`.trim();
  // Retained Hermes sandboxes can contain an unrelated .openclaw directory.
  if (selectionConfig.agent === "hermes") return writeSelection;
  if (!managedProfileApplied) return writeSelection;
  return `${writeSelection}
config_dir=/sandbox/.openclaw
if [ -d "$config_dir" ]; then
  current_uid="$(id -u)"
  config_dir_uid="$(stat -c '%u' "$config_dir" 2>/dev/null || echo '')"
  if [ -L "$config_dir" ] || [ "$config_dir_uid" != "$current_uid" ]; then
    echo "Refusing managed OpenClaw state initialization through an unowned directory" >&2
    exit 1
  fi
  for state_path in "$config_dir/agents" "$config_dir/agents/main" "$config_dir/agents/main/sessions"; do
    if [ -L "$state_path" ]; then
      echo "Refusing managed OpenClaw session initialization through a symlink" >&2
      exit 1
    fi
  done
  umask 077
  mkdir -p "$config_dir/agents/main/sessions"
  chmod 700 "$config_dir/agents" "$config_dir/agents/main" "$config_dir/agents/main/sessions"
fi
exit`;
}
