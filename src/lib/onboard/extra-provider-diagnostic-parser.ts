// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Compatibility export for legacy consumers. The CLI provider adapter owns
// diagnostic parsing. New consumers must use the adapter parser. Remove this
// wrapper under #9813 after no production consumer imports it.
export { reportsExactProviderNotFound } from "../adapters/openshell/provider-diagnostic-cli";
