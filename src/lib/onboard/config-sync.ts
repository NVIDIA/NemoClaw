// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ProviderSelectionConfig } from "../inference/config";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";

export interface RunSandboxConfigSyncDeps {
  getSelectionConfig: () => ProviderSelectionConfig | null;
  runConnectScript: (sandboxName: string, scriptContent: string) => Promise<void>;
  managedProfileApplied?: boolean;
  reconcileCustomOpenClawRoute?: boolean;
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
    reconcileCustomOpenClawRoute = false,
  ): Promise<void> {
    await runSandboxConfigSync(sandboxName, {
      getSelectionConfig: () => deps.getProviderSelectionConfig(provider, model),
      managedProfileApplied,
      reconcileCustomOpenClawRoute,
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

// Write `~/.nemoclaw/config.json` and normalize OpenClaw config-dir perms
// inside the sandbox. Also replaces the historical zero-byte config.json placeholder
// that crashes the OpenClaw nemoclaw plugin's loadOnboardConfig. Fixes #3999.
export async function runSandboxConfigSync(
  sandboxName: string,
  deps: RunSandboxConfigSyncDeps,
): Promise<void> {
  const selectionConfig = deps.getSelectionConfig();
  if (!selectionConfig) return;
  const sandboxConfig = { ...selectionConfig, onboardedAt: new Date().toISOString() };
  const script = buildSandboxConfigSyncScript(
    sandboxConfig,
    deps.managedProfileApplied === true,
    deps.reconcileCustomOpenClawRoute === true,
  );
  await deps.runConnectScript(sandboxName, script);
}

export function buildSandboxConfigSyncScript(
  selectionConfig: ProviderSelectionConfig & { agent?: string },
  managedProfileApplied = false,
  reconcileCustomOpenClawRoute = false,
): string {
  const encodedModel = Buffer.from(selectionConfig.model, "utf8").toString("base64");
  const customRouteReconcile = reconcileCustomOpenClawRoute
    ? `
    custom_route_marker="$config_dir/.nemoclaw-custom-route-pending"
    if [ -f "$config_dir/openclaw.json" ]; then
      if [ ! -f "$custom_route_marker" ] || [ -L "$custom_route_marker" ]; then
        echo "Refusing custom OpenClaw route reconciliation without its regular receipt" >&2
        exit 1
      fi
      NEMOCLAW_CUSTOM_ROUTE_MODEL_B64=${encodedModel} python3 -I - \
        "$config_dir/openclaw.json" "$custom_route_marker" <<'PYNEMOCLAWCUSTOMROUTE'
import base64
import hashlib
import json
import os
import re
import stat
import sys

config_path, marker_path = sys.argv[1:]
model = base64.b64decode(
    os.environ["NEMOCLAW_CUSTOM_ROUTE_MODEL_B64"], validate=True
).decode("utf-8")
if len(model) > 512 or re.fullmatch(r"[A-Za-z0-9._:/-]+", model) is None:
    raise SystemExit("custom OpenClaw route model is invalid")


def open_regular(path, flags):
    descriptor = os.open(path, flags | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
    metadata = os.fstat(descriptor)
    current = os.stat(path, follow_symlinks=False)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != (current.st_dev, current.st_ino)
    ):
        os.close(descriptor)
        raise OSError("path is not a trusted regular file")
    return descriptor


config_fd = open_regular(config_path, os.O_RDWR)
marker_fd = open_regular(marker_path, os.O_RDWR)
try:
    with os.fdopen(config_fd, "r+", encoding="utf-8", closefd=False) as config_file:
        config = json.load(config_file)
        if not isinstance(config, dict):
            raise ValueError("OpenClaw config must be an object")
        agents = config.setdefault("agents", {})
        defaults = agents.setdefault("defaults", {})
        model_config = defaults.setdefault("model", {})
        providers = config.setdefault("models", {}).setdefault("providers", {})
        inference = providers.setdefault("inference", {})
        if not all(
            isinstance(value, dict)
            for value in (agents, defaults, model_config, providers, inference)
        ):
            raise ValueError("OpenClaw config has an invalid model structure")
        models = inference.get("models")
        if not isinstance(models, list) or not models:
            models = [{}]
            inference["models"] = models
        first = models[0]
        if not isinstance(first, dict):
            first = {}
            models[0] = first
        provider_model = model if model.startswith("inference/") else f"inference/{model}"
        bare_model = model.removeprefix("inference/")
        model_changed = first.get("id") not in (bare_model, provider_model)
        model_config["primary"] = provider_model
        first["id"] = bare_model
        first["name"] = provider_model
        if model_changed:
            first.pop("contextWindow", None)
            first.pop("maxTokens", None)
        config_file.seek(0)
        json.dump(config, config_file, indent=2)
        config_file.write("\\n")
        config_file.truncate()
        config_file.flush()
        os.fsync(config_fd)
        config_file.seek(0)
        digest = hashlib.sha256(config_file.read().encode("utf-8")).hexdigest()
    with os.fdopen(marker_fd, "w", encoding="ascii", closefd=False) as marker_file:
        marker_file.write(f"{digest}  openclaw.json\\n")
        marker_file.flush()
        os.fsync(marker_fd)
finally:
    os.close(marker_fd)
    os.close(config_fd)
PYNEMOCLAWCUSTOMROUTE
    fi`
    : "";
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
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
chmod 600 "$nemoclaw_config"
`.trim();
  // Retained Hermes sandboxes can contain an unrelated .openclaw directory.
  if (selectionConfig.agent === "hermes") return writeSelection;
  if (managedProfileApplied) {
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
  // Managed startup has already created OpenClaw's baseline state before its
  // gateway becomes reachable. Re-running native setup here can rewrite live
  // state and terminate the sandbox while onboarding is connected.
  return `${writeSelection}
config_dir=/sandbox/.openclaw
if [ -d "$config_dir" ]; then
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || echo unknown)"
  if [ "$config_dir_owner" != "root" ]; then
    if [ -L "$config_dir" ] || [ -L "$config_dir/openclaw.json" ] || [ -L "$config_dir/.config-hash" ]; then
      echo "Refusing OpenClaw state initialization through a symlink" >&2
      exit 1
    fi
    export HOME=/sandbox OPENCLAW_STATE_DIR="$config_dir" OPENCLAW_CONFIG_PATH="$config_dir/openclaw.json"
${customRouteReconcile}
    /usr/local/bin/openclaw config validate
    (cd "$config_dir" && sha256sum openclaw.json >.config-hash)
    python3 -I /usr/local/lib/nemoclaw/normalize_mutable_config_perms.py "$config_dir" "$current_uid" "$(id -g)"
  fi
fi
exit
`.trim();
}
