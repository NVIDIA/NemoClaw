// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// This native ESM boundary preserves import conditions when the CLI builds as
// CommonJS. Keep SDK loading lazy and this module free of top-level await.
export async function importOpenShellSdk(): Promise<unknown> {
  const packageName = "@nvidia/openshell-sdk";
  return import(packageName);
}

export async function importOpenShellRawSdk(): Promise<Readonly<{ SandboxPolicySchema: unknown }>> {
  const packageName = "@nvidia/openshell-sdk/raw";
  return import(packageName) as Promise<Readonly<{ SandboxPolicySchema: unknown }>>;
}
