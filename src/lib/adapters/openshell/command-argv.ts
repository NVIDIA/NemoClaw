// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Namespace access keeps the resolver replaceable in focused command tests.
import * as openshellResolveModule from "./resolve";

export function resolveOpenshellBinary(): string {
  return openshellResolveModule.resolveOpenshell() ?? "openshell";
}

export function buildOpenshellCommand(args: readonly string[]): string[] {
  return [resolveOpenshellBinary(), ...args];
}
