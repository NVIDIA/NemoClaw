// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function nativeWorkerApiFixture(root: string, mockPort: number): string {
  const runtime = path.resolve("packaging/windows/runtime");
  if (process.platform === "win32") return runtime;

  // This portable API fixture uses an owned Unix socket, not Windows transport proof.
  const portableRuntime = path.join(root, "runtime");
  fs.cpSync(runtime, portableRuntime, { recursive: true });
  fs.renameSync(
    path.join(portableRuntime, "native-local-pipe.mts"),
    path.join(portableRuntime, "native-local-pipe-original.mts"),
  );
  fs.writeFileSync(
    path.join(portableRuntime, "native-local-pipe.mts"),
    `export { readNativeBrokerBootstrap, requestNativeBrokerBootstrap } from "./native-local-pipe-original.mts";
export function nativeLocalPipeName(port) {
  if (port !== ${mockPort}) throw new Error("Unexpected fixture pipe port");
  return ${JSON.stringify(path.join(root, "mock.sock"))};
}
`,
  );
  return portableRuntime;
}
