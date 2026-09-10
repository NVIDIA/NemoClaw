// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export const NATIVE_WORKER_MODES = [
  "openclaw-turn",
  "openclaw-web",
  "pi-turn",
  "hermes-turn",
  "deepagents-turn",
  "interactive",
  "nemocua",
] as const;
export type NativeWorkerMode = (typeof NATIVE_WORKER_MODES)[number];

export function nativeDistributionAsset(
  name: "NemoClaw.Runtime.exe" | "native-inference-manifest.json" | "onboarding",
) {
  const root = process.env.NEMOCLAW_NATIVE_RUNTIME_ROOT;
  if (!root || !path.isAbsolute(root))
    throw new Error("The installed application root is unavailable.");
  return path.join(root, "app", name);
}

export function nativeWorkerAssets(runtimeRoot: string, mode: NativeWorkerMode) {
  if (!path.isAbsolute(runtimeRoot) || !NATIVE_WORKER_MODES.includes(mode))
    throw new Error("The prebuilt worker identity is invalid.");
  const root = path.join(runtimeRoot, "workers");
  return {
    entry: path.join(root, "native-runtime.cjs"),
    root,
    environment: { NEMOCLAW_WORKER_ROOT: root, NEMOCLAW_WORKER_MODE: mode },
  };
}

export function nativeGuestAsset(name: string) {
  if (
    !/^(?:openclaw-invoke\.cjs|(?:hermes|deepagents)-(?:turn|console|console-probe|dashboard|dashboard-probe)\.pyc)$/u.test(
      name,
    )
  )
    throw new Error("The prebuilt worker asset is invalid.");
  const root = process.env.NEMOCLAW_WORKER_ROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("The prebuilt worker root is unavailable.");
  return path.join(root, name);
}
