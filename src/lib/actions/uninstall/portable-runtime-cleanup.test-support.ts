// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RETIREMENT_COMPETITOR_SCRIPT = String.raw`
  import fs from "node:fs";
  const [lifecycleUrl, registryUrl, stateDir, registryFile, receiptFile, marker, sandboxName, control] = process.argv.slice(1);
  const lifecycle = (await import(lifecycleUrl)).default;
  const registry = (await import(registryUrl)).default;
  const attempt = (owner) => {
  const mutate = () => {
    fs.writeFileSync(marker, "entered");
    fs.unlinkSync(receiptFile);
  };
  try {
    if (owner === "registry-only") {
      registry.withRegistryLockAt(registryFile, mutate, { maxRetries: 2, wait: () => {} });
    } else {
      lifecycle.withMcpLifecycleLockSync(owner, () => registry.withRegistryLockAt(
        registryFile,
        mutate,
        { maxRetries: 2, wait: () => {} },
      ), { stateDir, pollIntervalMs: 1, timeoutMs: 10 });
    }
    return 0;
  } catch {
    return 2;
  }
  };
  if (!control) process.exit(attempt(sandboxName));
  fs.writeFileSync(control + ".ready", "ready");
  while (!fs.existsSync(control + ".trigger")) await new Promise(resolve => setTimeout(resolve, 1));
  const resultPayload = JSON.stringify([attempt(sandboxName), attempt("registry-only")]);
  const resultTmp = control + ".result.tmp";
  fs.writeFileSync(resultTmp, resultPayload);
  fs.renameSync(resultTmp, control + ".result");
  process.exit(0);
`;
