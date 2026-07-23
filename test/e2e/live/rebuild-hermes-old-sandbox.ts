// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { formatSandboxBaseImageResolutionLabels } from "../../../src/lib/sandbox-base-image";

interface RebuildHermesOldSandboxDockerfileOptions {
  baseTag: string;
  baseResolutionMetadata: Parameters<typeof formatSandboxBaseImageResolutionLabels>[0] | null;
  apiServerKey: string;
  discordPlaceholder: string;
  kanbanTaskTitle: string;
}

/**
 * Build the synthetic historical Hermes sandbox used by the rebuild test.
 *
 * The raw OpenShell sandbox intentionally starts with the default filesystem
 * policy, which does not allow executing the fixture's Hermes CLI under
 * /opt/hermes. Seed the real historical kanban database while Docker is still
 * building the image, before OpenShell applies that runtime boundary.
 */
export function buildRebuildHermesOldSandboxDockerfile(
  options: RebuildHermesOldSandboxDockerfileOptions,
): string {
  return [
    `FROM ${options.baseTag}`,
    ...(options.baseResolutionMetadata
      ? [formatSandboxBaseImageResolutionLabels(options.baseResolutionMetadata)]
      : []),
    "USER sandbox",
    "WORKDIR /sandbox",
    "RUN mkdir -p /sandbox/.hermes/memories \\",
    "             /sandbox/.hermes/sessions \\",
    "             /sandbox/.hermes/workspace \\",
    "    && printf '%s\\n' \\",
    "      '_config_version: 12' \\",
    "      'platforms:' \\",
    "      '  discord:' \\",
    "      '    enabled: true' \\",
    `      '    token: "${options.discordPlaceholder}"' \\`,
    "      '  api_server:' \\",
    "      '    enabled: true' \\",
    "      '    extra:' \\",
    "      '      port: 18642' \\",
    "      '      host: 127.0.0.1' \\",
    "      > /sandbox/.hermes/config.yaml \\",
    "    && printf '%s\\n' \\",
    "      'API_SERVER_PORT=18642' \\",
    "      'API_SERVER_HOST=127.0.0.1' \\",
    `      'API_SERVER_KEY=${options.apiServerKey}' \\`,
    `      'DISCORD_BOT_TOKEN=${options.discordPlaceholder}' \\`,
    "      > /sandbox/.hermes/.env",
    "RUN /usr/local/bin/hermes kanban init \\",
    `    && /usr/local/bin/hermes kanban create ${shellQuote(options.kanbanTaskTitle)} --initial-status blocked --json \\`,
    "    && test -s /sandbox/.hermes/kanban.db",
    'CMD ["/bin/bash"]',
    "",
  ].join("\n");
}
