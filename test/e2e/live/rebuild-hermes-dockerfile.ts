// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OldHermesDockerfileOptions {
  baseTag: string;
  discordPlaceholder: string;
}

export function buildOldHermesDockerfile(options: OldHermesDockerfileOptions): string {
  return [
    `FROM ${options.baseTag}`,
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
    `      'DISCORD_BOT_TOKEN=${options.discordPlaceholder}' \\`,
    "      > /sandbox/.hermes/.env",
    'CMD ["/bin/bash"]',
    "",
  ].join("\n");
}
