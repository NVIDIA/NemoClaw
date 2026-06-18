# Upstream Source-of-Truth References

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

Pointers to the upstream repositories and prebuilt packages this skill delegates
to instead of reimplementing. Operation mechanics, parameters, defaults, and
package resolution live upstream; this skill owns only the digital twin workflow
routing, runtime setup, validation scope, output policy, and reporting that wrap
them.

When a file here names a tool, prefer the upstream URL it records for the most
current version — the local notes are a snapshot and a resolution recipe, not a
copy of the upstream docs.

## Contents

- [`usd-optimize.md`](usd-optimize.md) — Scene Optimizer operation mechanics and
  prebuilt-package resolution (upstream
  [usd-optimize](https://github.com/NVIDIA-omniverse/usd-optimize/)). Resolve
  per-operation guides through `$SCENE_OPTIMIZER_PACKAGE_ROOT` / `$SO_HOME` or
  the upstream `.agents/operations/<key>.md` path rather than duplicating them
  in this repo.
