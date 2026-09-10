// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSelectionConfig } from "../inference/config";

export interface RunSandboxConfigSyncDeps {
  getSelectionConfig: () => ProviderSelectionConfig | null;
  runConnectScript: (sandboxName: string, scriptContent: string) => void;
}

export interface NemoClawConfigSyncDeps {
  getProviderSelectionConfig(provider: string, model: string): ProviderSelectionConfig | null;
  run(argv: string[], options: Record<string, unknown>): unknown;
  openshellArgv(args: string[]): string[];
}

const skipSandboxIdentityRevalidation = (_operation: string): void => undefined;

export function createNemoClawConfigSync(deps: NemoClawConfigSyncDeps) {
  return function syncNemoClawConfigInSandbox(
    sandboxName: string,
    provider: string,
    model: string,
    revalidateSandboxIdentity: (operation: string) => void = skipSandboxIdentityRevalidation,
  ): void {
    runSandboxConfigSync(sandboxName, {
      getSelectionConfig: () => deps.getProviderSelectionConfig(provider, model),
      runConnectScript: (name, scriptContent) => {
        revalidateSandboxIdentity(`synchronize OpenClaw config in sandbox '${name}'`);
        deps.run(deps.openshellArgv(sandboxConfigSyncArgs(name)), {
          stdio: ["pipe", "ignore", "inherit"],
          input: scriptContent,
        });
      },
    });
  };
}

/** Run config sync without allocating the interactive sandbox terminal transport. */
export function sandboxConfigSyncArgs(sandboxName: string): string[] {
  return ["sandbox", "exec", "-n", sandboxName, "--no-tty", "--", "/bin/bash", "-s"];
}

// Write `~/.nemoclaw/config.json` and normalize OpenClaw config-dir perms
// inside the sandbox. Also replaces the historical zero-byte config.json placeholder
// that crashes the OpenClaw nemoclaw plugin's loadOnboardConfig. Fixes #3999.
export function runSandboxConfigSync(sandboxName: string, deps: RunSandboxConfigSyncDeps): void {
  const selectionConfig = deps.getSelectionConfig();
  if (!selectionConfig) return;
  const sandboxConfig = { ...selectionConfig, onboardedAt: new Date().toISOString() };
  const script = buildSandboxConfigSyncScript(sandboxConfig);
  deps.runConnectScript(sandboxName, script);
}

export function buildSandboxConfigSyncScript(selectionConfig: ProviderSelectionConfig): string {
  // Native baseline setup preserves valid routing and creates its own state.
  return `
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
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
chmod 600 "$nemoclaw_config"
config_dir=/sandbox/.openclaw
if [ -d "$config_dir" ]; then
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || echo unknown)"
  if [ "$config_dir_owner" != "root" ]; then
    if [ -L "$config_dir" ] || [ -L "$config_dir/openclaw.json" ] || [ -L "$config_dir/.config-hash" ]; then
      echo "Refusing OpenClaw state initialization through a symlink" >&2
      exit 1
    fi
    export HOME=/sandbox OPENCLAW_STATE_DIR="$config_dir" OPENCLAW_CONFIG_PATH="$config_dir/openclaw.json"
    /usr/local/bin/openclaw config validate
    /usr/local/bin/openclaw setup --baseline
    (cd "$config_dir" && sha256sum openclaw.json >.config-hash)
    python3 -I /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py "$config_dir" "$current_uid" "$(id -g)"
  fi
fi
exit
`.trim();
}
