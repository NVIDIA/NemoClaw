// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedPortBoundary from "../../../nemoclaw/dist/shared/port-boundary.cjs";

// TypeScript's CommonJS build exposes the named export directly, while the
// plugin's tsx ESM source boundary exposes the same module through `default`.
// Keep this adapter until both package consumers use one module loader.
const portBoundary = importedPortBoundary as typeof importedPortBoundary & {
  default?: typeof importedPortBoundary;
};

export const { parseServicePortOverride } = portBoundary.default ?? portBoundary;
