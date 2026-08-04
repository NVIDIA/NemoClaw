// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cleanupInstalledDualStationVllmRuntime } from "./vllm-station-runtime-receipt";

async function main(): Promise<void> {
  const result = await cleanupInstalledDualStationVllmRuntime();
  if (result.kind === "not-installed") return;
  console.log(
    `Removed managed dual-Station vLLM containers: ${result.removedContainerIds.join(", ")}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `Refusing uninstall before managed dual-Station cleanup: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
