// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Named timeout constants for openshell child-process execution.
 *
 * Every openshell CLI call should use one of these categories rather than
 * raw millisecond literals. This ensures consistent behaviour across all
 * call sites and makes it easy to tune timeouts from a single location.
 *
 * Categories:
 *   PROBE    — read-only queries that should return instantly (list, status, info, ssh-config)
 *   OPERATION — mutating commands (provider CRUD, forward start/stop, gateway select)
 *   HEAVY    — destructive or long-running (sandbox delete, gateway destroy, build)
 *   DOWNLOAD — file transfers over the sandbox SSH tunnel (config download)
 */

/** Quick probe — sandbox list, status, gateway info, forward list, ssh-config */
export const OPENSHELL_PROBE_TIMEOUT_MS = 15_000;

/** In-sandbox inference.local route probe used during connect recovery */
export const OPENSHELL_INFERENCE_ROUTE_PROBE_TIMEOUT_MS = 10_000;

/** Mutating operations — provider create/delete, gateway select, forward start/stop */
export const OPENSHELL_OPERATION_TIMEOUT_MS = 30_000;

/** Heavy operations — sandbox delete, gateway destroy, full build */
export const OPENSHELL_HEAVY_TIMEOUT_MS = 60_000;

/** Sandbox download (config file fetch over SSH) */
export const OPENSHELL_DOWNLOAD_TIMEOUT_MS = 30_000;
