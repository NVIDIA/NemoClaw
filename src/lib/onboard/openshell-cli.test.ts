// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createOpenshellCliHelpers } from "./openshell-cli";

it("binds typed gateway capabilities to the onboarding executable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-capabilities-"));
  try {
    const binary = path.join(directory, "openshell");
    fs.writeFileSync(
      binary,
      `#!/bin/sh
case "$*" in
  'gateway select nemoclaw-8091') exit 0 ;;
  'status -g nemoclaw-8091') printf 'Gateway: nemoclaw-8091\\nStatus: Connected\\nServer: http://127.0.0.1:8091/\\n'; exit 0 ;;
  'gateway list -o json') printf '[{"name":"nemoclaw-8091","endpoint":"http://127.0.0.1:8091","active":true}]'; exit 0 ;;
esac
exit 91
`,
      { mode: 0o700 },
    );
    const helpers = createOpenshellCliHelpers({
      getCachedBinary: () => binary,
      setCachedBinary: vi.fn(),
      getGatewayPort: () => 8091,
      getDockerDriverGatewayEndpoint: () => "http://127.0.0.1:8091",
    });
    const target = { kind: "named", gatewayName: "nemoclaw-8091" } as const;
    expect(await helpers.gatewayLifecycleAdapter.selectGateway({ target })).toEqual({
      ok: true,
      state: "completed",
    });
    expect(
      await helpers.gatewayReuseAdapter.observeGatewayReuse({ target, expectedGatewayPort: 8091 }),
    ).toMatchObject({ namedMetadata: true, endpointBinding: "match" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
