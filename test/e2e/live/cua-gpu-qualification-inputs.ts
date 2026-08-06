// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function requiredEnv(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (!value || value.length > 4096 || !pattern.test(value)) {
    throw new Error(`${name} is required and invalid`);
  }
  return value;
}

export function requiredAbsoluteFile(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 4096 || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must name one absolute file`);
  }
  return value;
}
