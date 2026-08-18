// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export async function runAttemptsUntil(
  attempts: number,
  action: (attempt: number) => Promise<boolean>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await action(attempt)) return true;
  }
  return false;
}

export async function runUntilDeadline(
  deadline: number,
  action: (attempt: number) => Promise<boolean>,
): Promise<boolean> {
  let attempt = 1;
  while (Date.now() < deadline) {
    if (await action(attempt)) return true;
    attempt += 1;
  }
  return false;
}

export async function forEachFixtureSequentially<T>(
  values: Iterable<T>,
  action: (value: T) => Promise<void>,
): Promise<void> {
  for (const value of values) await action(value);
}
