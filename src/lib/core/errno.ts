// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared errno helpers for safely narrowing caught errors to
 * `NodeJS.ErrnoException`.
 *
 * Multiple modules (config-io, credentials, http-probe, onboard,
 * onboard-session, registry) previously defined their own
 * `isErrnoException` + `ErrnoLike` type.  This module unifies them
 * into a single source of truth.
 *
 * Usage in catch blocks:
 *
 *   ```ts
 *   try { … } catch (error) {
 *     if (isErrnoException(error) && error.code === "ENOENT") { … }
 *   }
 *   ```
 */

/**
 * Narrow an unknown caught value to `NodeJS.ErrnoException`.
 *
 * Accepts `unknown` so callers never need a pre-cast.  Returns `true`
 * when the value is a non-null object carrying a `code` or `errno`
 * property — the two fields Node.js sets on filesystem / child-process
 * errors.
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    ("code" in error || "errno" in error)
  );
}

/**
 * Convenience: true when the error is an `EACCES` or `EPERM` errno,
 * commonly used for permission-denied guards.
 */
export function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoException(error) && (error.code === "EACCES" || error.code === "EPERM");
}
