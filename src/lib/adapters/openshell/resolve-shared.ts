// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "./resolve";

/** Resolve OpenShell without exiting when it is unavailable. */
export function resolveOpenshellBinaryOrNull(): string | null {
  return resolveOpenshell();
}
