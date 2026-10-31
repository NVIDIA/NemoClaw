// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../../src/lib/core/shell-quote.ts";

export type NativePluginVersion = "v1" | "v2";

export function nativeWeatherPluginWriteScript(version: NativePluginVersion): string {
  const packageJson = JSON.stringify({
    name: "@nemoclaw/e2e-native-weather",
    version: version === "v1" ? "1.0.0" : "2.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js", "openclaw.plugin.json"],
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.7.1" },
  });
  const manifest = JSON.stringify({
    id: "weather",
    name: "NemoClaw Native Weather",
    version: version === "v1" ? "1.0.0" : "2.0.0",
    description: "Dependency-free native plugin lifecycle fixture",
    activation: { onStartup: true },
    contracts: { tools: ["get_weather"] },
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  });
  const entrypoint = `const plugin = {
  id: "weather",
  name: "NemoClaw Native Weather",
  version: ${JSON.stringify(version === "v1" ? "1.0.0" : "2.0.0")},
  description: "Dependency-free native plugin lifecycle fixture",
  register(api) {
    api.registerTool({
      name: "get_weather",
      label: "Get Weather",
      description: "Return deterministic weather data.",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
        additionalProperties: false,
      },
      async execute(_toolCallId, params) {
        const details = {
          location: String(params.location),
          condition: "clear",
          fixtureVersion: ${JSON.stringify(version)},
        };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details };
      },
    });
  },
};
export default plugin;
`;
  return [
    "set -eu",
    "source_dir=/sandbox/e2e-native-weather",
    'rm -rf -- "$source_dir"',
    'mkdir -p -- "$source_dir"',
    `printf '%s' ${shellQuote(packageJson)} > "$source_dir/package.json"`,
    `printf '%s' ${shellQuote(manifest)} > "$source_dir/openclaw.plugin.json"`,
    `printf '%s' ${shellQuote(entrypoint)} > "$source_dir/index.js"`,
    'HOME=/sandbox openclaw plugins install --force --accept-capabilities "$source_dir"',
  ].join("\n");
}
