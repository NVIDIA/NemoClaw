// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

/**
 * Replace the strict descriptor read in fake-OpenShell CLI subprocess tests.
 *
 * Those fixtures provide a fake `openshell` executable, but descriptor reads
 * bypass the CLI and connect directly to the gateway's gRPC endpoint. They
 * therefore cannot model this response with another fake CLI argv branch.
 * Limit the child-process interception to the one exact compiled
 * snapshot-to-routing import edge; unrelated module loads retain Node's
 * normal result. Remove this
 * preload when the subprocess harness owns a fake gRPC gateway (or official
 * bindings expose a fixture-local injectable client).
 */
export function writeOpenShellSandboxDescriptorPreload(home: string, image: string): string {
  const preload = path.join(home, "openshell-sandbox-descriptor-preload.cjs");
  fs.writeFileSync(
    preload,
    `const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function loadWithSandboxDescriptor(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  const fromSnapshot =
    typeof parent?.filename === "string" &&
    /[\\/]actions[\\/]sandbox[\\/]snapshot\\.[cm]?js$/.test(parent.filename);
  if (fromSnapshot && request === "../../adapters/openshell/sandbox-control-routing") {
    return {
      ...loaded,
      getOpenShellSandboxDescriptor: async (_gatewayName, sandboxName) => ({
        id: sandboxName + "-id",
        name: sandboxName,
        image: ${JSON.stringify(image)},
      }),
    };
  }
  return loaded;
};
`,
    { mode: 0o600 },
  );
  return [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
}
