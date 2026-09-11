// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const RETIREMENT_COMPETITOR_SCRIPT = String.raw`
  import fs from "node:fs";
  const [lifecycleUrl, registryUrl, stateDir, registryFile, receiptFile, marker, sandboxName, control] = process.argv.slice(1);
  const lifecycleModule = await import(lifecycleUrl);
  const registryModule = await import(registryUrl);
  const lifecycle = lifecycleModule.default ?? lifecycleModule;
  const registry = registryModule.default ?? registryModule;
  if (typeof lifecycle.withMcpLifecycleLockSync !== "function" ||
      typeof registry.withRegistryLockAt !== "function") process.exit(3);
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
      ), { stateDir, pollIntervalMs: 1, timeoutMs: 1_000 });
    }
    return 0;
  } catch (error) {
    if (error?.name === "ProcessBoundLockContentionError" ||
        (error instanceof Error && error.message.startsWith("Timed out waiting for the sandbox mutation lock for '"))) return 2;
    console.error(error);
    return 3;
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
