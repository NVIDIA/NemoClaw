// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

export function writeOkOpenshell(fakeBin: string): void {
  writeExecutable(
    path.join(fakeBin, "openshell"),
    '#!/usr/bin/env bash\nif [ "${1:-}" = sandbox ] && [ "${2:-}" = ssh-config ]; then printf "Host openshell-%s\\n  HostName 127.0.0.1\\n  User sandbox\\n" "${3:-sandbox}"; fi\nexit 0\n',
  );
  writeExecutable(
    path.join(fakeBin, "ssh"),
    "#!/usr/bin/env bash\nprintf '%s\\n' '{\"version\":1,\"installRecords\":{}}'\n",
  );
}
