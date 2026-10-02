// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

interface OkOpenshellFixtureOptions {
  gatewayPort?: number;
  inferenceRoute?: Readonly<{
    gatewayName: string;
    provider: string;
    model: string;
    commandLogPath?: string;
  }>;
}

function validateFixtureRouteValue(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:/-]+$/u.test(value)) {
    throw new Error(`Invalid fixture ${label}`);
  }
  return value;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function writeOkOpenshell(fakeBin: string, options: OkOpenshellFixtureOptions = {}): void {
  const gatewayPort = options.gatewayPort ?? 8080;
  let inferenceRoute = "";
  if (options.inferenceRoute) {
    const gatewayName = validateFixtureRouteValue(
      options.inferenceRoute.gatewayName,
      "gateway name",
    );
    const provider = validateFixtureRouteValue(options.inferenceRoute.provider, "provider");
    const model = validateFixtureRouteValue(options.inferenceRoute.model, "model");
    const commandLog = options.inferenceRoute.commandLogPath
      ? `printf '%s\\n' "$*" >> ${shellSingleQuote(options.inferenceRoute.commandLogPath)}; `
      : "";
    inferenceRoute = `if [ "\${1:-}" = inference ] && [ "\${2:-}" = get ]; then ${commandLog}if [ "$#" -eq 4 ] && [ "\${3:-}" = -g ] && [ "\${4:-}" = ${shellSingleQuote(gatewayName)} ]; then printf '%s\\n' 'Gateway inference:' '  Provider: ${provider}' '  Model: ${model}'; fi; fi\n`;
  }
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash\ngateway_name="\${OPENSHELL_GATEWAY:-nemoclaw}"\nif [ "\${1:-}" = policy ] && [ "\${2:-}" = list ] && [[ " $* " = *" --global "* ]]; then printf '%s\\n' 'No global policy history found' >&2; fi\nif [ "\${1:-}" = policy ] && [ "\${2:-}" = get ] && [[ " $* " = *" --output json "* ]]; then printf '{"scope":"sandbox","sandbox":"%s","status":"effective","policy_source":"sandbox","hash":"fixture-policy","active_version":1,"policy":{}}\\n' "\${!#}"; fi\nif [ "\${1:-}" = policy ] && [ "\${2:-}" = get ] && [[ " $* " = *" --base "* ]]; then printf 'version: 1\\n'; fi\nif [ "\${1:-}" = status ]; then printf 'Gateway: %s\\nStatus: Connected\\nServer: http://127.0.0.1:${gatewayPort}/\\n' "$gateway_name"; fi\nif [ "\${1:-}" = gateway ] && [ "\${2:-}" = info ]; then printf 'Gateway: %s\\nGateway endpoint: http://127.0.0.1:${gatewayPort}\\n' "$gateway_name"; fi\nif [ "\${1:-}" = gateway ] && [ "\${2:-}" = list ]; then printf '[{"name":"%s","endpoint":"http://127.0.0.1:${gatewayPort}","active":true}]\\n' "$gateway_name"; fi\nif [ "\${1:-}" = sandbox ] && [ "\${2:-}" = ssh-config ]; then printf "Host openshell-%s.default\\n  HostName 127.0.0.1\\n  User sandbox\\n" "\${3:-sandbox}"; fi\n${inferenceRoute}exit 0\n`,
  );
  writeExecutable(
    path.join(fakeBin, "ssh"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"version\":1,\"installRecords\":{}}'\n",
  );
}
