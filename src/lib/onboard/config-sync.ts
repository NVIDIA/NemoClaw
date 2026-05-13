// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { ProviderSelectionConfig } from "../inference/config";
import { secureTempFile } from "./temp-files";

export function buildSandboxConfigSyncScript(selectionConfig: ProviderSelectionConfig): string {
  // Do not rewrite openclaw.json at runtime. Model routing is handled by the
  // host-side gateway (`openshell inference set` in Step 5), not from inside
  // the sandbox. We write the NemoClaw selection config and normalize the
  // mutable-default OpenClaw config permissions after the gateway has had a
  // chance to perform its own startup initialization.
  return `
set -euo pipefail
mkdir -p ~/.nemoclaw
cat > ~/.nemoclaw/config.json <<'EOF_NEMOCLAW_CFG'
${JSON.stringify(selectionConfig, null, 2)}
EOF_NEMOCLAW_CFG
config_dir=/sandbox/.openclaw
if [ -d "$config_dir" ]; then
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || echo unknown)"
  if [ "$config_dir_owner" != "root" ]; then
    chmod -R g+rwX,o-rwx "$config_dir" 2>/dev/null || true
    find "$config_dir" -type d -exec chmod g+s {} + 2>/dev/null || true
    chmod 2770 "$config_dir" 2>/dev/null || true
    chmod 660 "$config_dir/openclaw.json" "$config_dir/.config-hash" 2>/dev/null || true
  fi
fi
exit
`.trim();
}

export function writeSandboxConfigSyncFile(script: string): string {
  const scriptFile = secureTempFile("nemoclaw-sync", ".sh");
  fs.writeFileSync(scriptFile, `${script}\n`, { mode: 0o600 });
  return scriptFile;
}
