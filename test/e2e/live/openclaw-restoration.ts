// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";

export function restorationScript(
  options: { home?: string; openclaw?: string; node?: string } = {},
): string {
  const home = shellQuote(options.home ?? "/sandbox");
  const openclaw = shellQuote(options.openclaw ?? "openclaw");
  const node = shellQuote(options.node ?? "node");
  return `set -e; marker="$(cat ${home}/.openclaw/workspace/.rebuild-state-marker)"; for target in ${home}/.rebuild-unknown-marker ${home}/.openclaw/hooks/.rebuild-hook-marker ${home}/.openclaw/cron/.rebuild-cron-marker ${home}/.local/share/e2e-package/.rebuild-package-marker; do restored="$(cat "$target")"; test "$restored" = "$marker"; done; timeout="$(HOME=${home} ${openclaw} config get agents.defaults.timeoutSeconds --json)"; plugin="$(HOME=${home} ${openclaw} plugins inspect e2e-rebuild-plugin --runtime --json)"; printf "%s" "$plugin" | ${node} -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")).plugin; if (p?.id !== "e2e-rebuild-plugin" || p.status !== "loaded") process.exit(1);'; printf "%s\\n%s\\n" "$marker" "$timeout"`;
}
