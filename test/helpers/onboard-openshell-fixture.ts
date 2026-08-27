// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

export function writeOkOpenshell(
  fakeBin: string,
  options: { gatewayPort?: number; readySandboxGet?: boolean } = {},
): void {
  const gatewayPort = options.gatewayPort ?? 8080;
  const sandboxGet = options.readySandboxGet
    ? 'if [ "${1:-}" = sandbox ] && [ "${2:-}" = get ]; then printf "Sandbox:\\n\\n  Id: sbx-4f2a91c0d7\\n  Name: %s\\n  Phase: Ready\\n" "${!#}"; fi\n'
    : "";
  writeExecutable(
    path.join(fakeBin, "openshell"),
    `#!/usr/bin/env bash\n${sandboxGet}if [ "\${1:-}" = policy ] && [ "\${2:-}" = get ] && [[ " $* " = *" --output json "* ]]; then printf '{"scope":"sandbox","sandbox":"%s","status":"effective","policy_source":"sandbox","hash":"fixture-policy","active_version":1,"policy":{}}\\n' "\${!#}"; fi\nif [ "\${1:-}" = policy ] && [ "\${2:-}" = get ] && [[ " $* " = *" --base "* ]]; then printf 'version: 1\\n'; fi\nif [ "\${1:-}" = gateway ] && [ "\${2:-}" = info ]; then printf 'Gateway endpoint: http://127.0.0.1:${gatewayPort}\\n'; fi\nif [ "\${1:-}" = sandbox ] && [ "\${2:-}" = ssh-config ]; then printf "Host openshell-%s.default\\n  HostName 127.0.0.1\\n  User sandbox\\n" "\${3:-sandbox}"; fi\nexit 0\n`,
  );
  writeExecutable(
    path.join(fakeBin, "ssh"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"version\":1,\"installRecords\":{}}'\n",
  );
}
