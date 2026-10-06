// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one statement of which HTTP statuses an inference probe may retry.
 *
 * 429 = Too Many Requests; 502/503/504 = upstream gateway and availability
 * flakes (NVIDIA Endpoints and other hosted providers periodically emit these
 * for minutes at a time). All four mean the route answered and declined to
 * serve the request, which is not evidence that the route is broken, so a
 * probe retries them with backoff before reporting a hard failure. See issues
 * #2980, #3033, and #10709.
 *
 * This module is plain typed ESM so the require()-based onboarding probe loop
 * in `./probe-retry` and the typed sandbox status probe can read one
 * definition instead of keeping their own copies.
 */
export const RETRIABLE_HTTP_PROBE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
