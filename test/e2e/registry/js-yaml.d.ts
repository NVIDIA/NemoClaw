// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Local type shim for js-yaml. The runtime package ships without
// TypeScript declarations; we only use `load` for YAML parsing.
declare module "js-yaml" {
  export function load(input: string): unknown;
  export function dump(obj: unknown, opts?: Record<string, unknown>): string;
  const _default: { load: typeof load; dump: typeof dump };
  export default _default;
}
