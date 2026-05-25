// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared recursive JSON-like types for loosely-typed data boundaries.
 *
 * Several modules (onboard, agent-onboard, policies, onboard-session)
 * defined their own Scalar / Value / Object triples for the same
 * purpose: representing data parsed from JSON, YAML, or environment
 * variables before it is validated into a narrower domain type.
 *
 * This module provides a single canonical set so the pattern is
 * consistent across the CLI codebase.
 *
 * Note: The plugin (`nemoclaw/src/`) has its own parallel types
 * (`PluginScalar`, `PluginValue`, `PluginRecord`) because the plugin
 * and CLI are compiled separately and cannot share imports.
 */

/** A single JSON-compatible scalar (includes `undefined` for optional fields). */
export type JsonScalar = string | number | boolean | null | undefined;

/** A recursive JSON-compatible value: scalar, object, or array. */
export type JsonValue = JsonScalar | JsonObject | JsonValue[];

/** A JSON-compatible object with string keys and recursive values. */
export type JsonObject = { [key: string]: JsonValue };

/** Generic object record used when parsed input has not been domain-validated. */
export type UnknownRecord = Record<string, unknown>;

/** Return true when a value is a non-array object record. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
