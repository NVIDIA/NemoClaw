// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export { resolveOpenShellSandboxId } from "../../adapters/openshell/sandbox-identity";
export {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapSequenceResult,
  runManagedBootstrapSequence,
} from "./adapter";
export { createDockerManagedBootstrapAdapter } from "./docker";
export type { ManagedBootstrapRuntimeProvider } from "./runtime-provider";
export { resolveCurrentManagedBootstrapRuntimeProvider } from "./runtime-providers";
