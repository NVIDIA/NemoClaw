// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { BUILT_IN_CHANNEL_MANIFESTS } from "../../../src/lib/messaging/channels/built-ins";
import type { ChannelManifest } from "../../../src/lib/messaging/manifest/types";

export const officialPluginInspections = Object.fromEntries(
  BUILT_IN_CHANNEL_MANIFESTS.flatMap((manifest: ChannelManifest) =>
    (manifest.agentPackages ?? []).flatMap((pkg) => {
      if (!pkg.spec.startsWith("npm:@openclaw/")) return [];
      const spec = pkg.spec.replace("npm:", "").replace("{{openclaw.version}}", "2026.9.1");
      const id = manifest.runtime?.openclaw?.channelName;
      return [
        [
          id,
          {
            plugin: { id, trustedOfficialInstall: true },
            install: {
              source: "npm",
              resolvedSpec: spec,
              integrity: pkg.integrityByVersion?.["2026.9.1"],
            },
          },
        ],
      ];
    }),
  ),
);

export function officialPluginInspectionShell(): string[] {
  return [
    'if [ "${1:-}" = "plugins" ] && [ "${2:-}" = "inspect" ]; then',
    '  case "${3:-}" in',
    ...Object.entries(officialPluginInspections).map(
      ([id, value]) => `    ${id}) printf '%s\\n' '${JSON.stringify(value)}'; exit 0 ;;`,
    ),
    "    *) exit 1 ;;",
    "  esac",
    "fi",
  ];
}
