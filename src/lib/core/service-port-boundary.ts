// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as importedPortBoundary from "../../../nemoclaw/dist/shared/port-boundary.cjs";

const sourceOrGeneratedPortBoundary = importedPortBoundary as typeof importedPortBoundary & {
  default?: typeof importedPortBoundary;
};

export const { parseServicePortOverride } =
  sourceOrGeneratedPortBoundary.default ?? sourceOrGeneratedPortBoundary;
