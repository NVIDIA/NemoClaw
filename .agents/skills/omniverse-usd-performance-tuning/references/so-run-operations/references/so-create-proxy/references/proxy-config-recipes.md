<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Proxy Config Recipes - Upstream Handoff

This local reference preserves the digitaltwin workflow milestone. Scene
Optimizer mechanics for this step are owned by upstream `usd-optimize`.

Proxy config recipes are composed from the per-mode sibling handoffs in this
folder rather than restating the same upstream doc. To avoid a duplicate
upstream-doc reference, this stub points to those siblings instead of
re-declaring the package path:

- Decimate-based proxy configs: see [`decimate-step-recipes.md`](decimate-step-recipes.md)
  (upstream `create-proxy/references/decimate-mode.md`).
- Decimation parameter tuning: see [`decimation-tuning.md`](decimation-tuning.md)
  (upstream `create-proxy/references/parameter-tuning.md`).
- Bounding-box proxy configs: see [`bounding-box-proxy-modes.md`](bounding-box-proxy-modes.md)
  (upstream `create-proxy/references/bounding-box-modes.md`).

For the public repository and package-root resolution rules, follow the sibling
handoff above for the relevant mode. Direct archive URLs are in
`references/upstreams/usd-optimize.md`. Do not clone the source repo just to
read upstream SO guidance.
