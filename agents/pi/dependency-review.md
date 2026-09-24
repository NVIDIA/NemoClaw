<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pi Dependency Review

This file records the reviewed dependency baseline for the Pi sandbox base image.
Update it whenever `agents/pi/pi-runtime/package-lock.json` changes.

- Package: `@earendil-works/pi-coding-agent@0.84.1`
- npm integrity: `sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==`
- npm SHA-1: `e098cada629fdeeb9df6e77c6d480d43e1b2c553`
- Lockfile: `agents/pi/pi-runtime/package-lock.json`
- Lockfile SHA-256: `6267ec58e69fc6cd53d3c753f28b0e25c00f4befdcae63e8e4924bee2abf0712`
- Locked packages: 144
- Audit command: `npm --prefix agents/pi/pi-runtime audit --registry=https://registry.yarnpkg.com --omit=dev`
- Audit date: August 14, 2026
- Audit result: `found 0 vulnerabilities`
- Registry metadata independently queried from npm: August 14, 2026

The package and integrity values match the accepted decision record for the Pi 0.84.1 candidate.
The image build asserts the version against `package.json` and the integrity value against the lockfile before installing, so an edited pin fails the build instead of shipping.

The lockfile records committed SHA-512 integrity values for all 144 resolved tarballs.
The base image installs the graph with `npm ci --omit=dev --ignore-scripts`.
npm verifies each downloaded tarball, and the build does not run install lifecycle scripts.
The published tarball includes `npm-shrinkwrap.json`, which fixes its transitive resolution.
The upstream shrinkwrap omitted integrity for six nested `@earendil-works` archives.
The NemoClaw lockfile supplies the registry-published SHA-512 values.
A reviewer independently confirmed those values against the downloaded tarball bytes on August 14, 2026.
The install is pinned to one exact version: a later Pi release requires a new dependency review, new integrity values, and new image digests.

The base image, the final image, and the startup entrypoint each set `PI_OFFLINE=1` and `PI_TELEMETRY=0`.
NemoClaw does not check what the Pi runtime does with those values; the deny-by-default network policy in `agents/pi/policy-additions.yaml` is the enforced control, and it allows only the managed inference route.
The installed tree is owned by root and carries no group or other write bits, so the sandbox user cannot replace the runtime it executes.
