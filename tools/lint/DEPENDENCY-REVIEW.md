<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributor Lint Dependency Review

## `eslint-plugin-sonarjs` 4.2.0

| Property | Reviewed value |
| --- | --- |
| Consumer | `oxlint.config.ts` cognitive-complexity rules |
| Dependency class | Root development dependency |
| Registry artifact | `eslint-plugin-sonarjs-4.2.0.tgz` |
| Integrity | `sha512-bqADfuNtTL7VK6RU29eoiFTtaaBKIpVPuX3bOl+rBpWSBa0zIBVZlqZNZQjfP6s4iXkAJokv5IsD8OsACkwApg==` |
| Declared license | `LGPL-3.0-only` |
| Lifecycle scripts | None declared |

NemoClaw executes this package only during contributor and CI lint checks. The package is not a
production dependency. The root package file allowlist does not include `tools/`, and
`npm pack --dry-run --json --ignore-scripts` does not include the SonarJS package code.
The plugin image cache uses `nemoclaw/package-lock.json`, which does not select SonarJS.

This review permits the package only inside that development-tool boundary. A version, license,
dependency-class, package-content, image, or publication change requires another review.
