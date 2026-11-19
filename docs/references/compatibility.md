<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compatibility Across Releases

NemoClaw v1 is in alpha, and its configuration is `v1alpha1`.
This page says what a release guarantees across releases, and what it does not.

## Use One Release Together

A release is its CLI, the SDK crate, its bundle (providers, OpenTofu, and pinned images and charts), and its configuration schema.
Use them together.
Mixing releases is not supported.
Refer to [bundle building](../build-deploy/build.md) for how a bundle pins its parts.

## Configuration

`v1alpha1` can change between releases without migration.
Release notes list breaking changes after releases are published ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Within a release, configuration from `export` re-applies to the same deployment.

## Deployment State

General state migration between releases is unavailable while v1 is in alpha.
This bundle supports one explicit exception: [intent format 29 upgrades to 30](../build-deploy/state.md#upgrade-intent-format-29-to-30), preserving the serialized document, ownership generations and pending recovery state.
Loading validates the record without rewriting it.
The next successful intent save writes format 30, which the older CLI cannot read.
Back up the whole state directory and keep the earlier bundle before upgrading.

Unsupported intent formats are refused without changing the record: "deployment state was written by a different NemoClaw release (intent record version N; this release reads M); keep using the CLI bundle that created the deployment, or destroy it with that bundle and create a new deployment; state retained".
For those formats, use the creating release to destroy the deployment, then create a new deployment with the new release, using a fresh `metadata.uid` and state directory.

The providers refuse state recorded under an older version of a resource's schema.
They do not upgrade it.

## Rust SDK API

`nemoclaw-sdk` follows Semantic Versioning for 0.x versions: a minor release, such as 0.1 to 0.2, can break the API.
The crate is not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Generate its API reference locally as [the SDK guide](sdk.md#package-distribution-and-api-reference) describes.
A hosted reference follows the documentation site ([#12644](https://github.com/NVIDIA/NemoClaw/issues/12644)).

## Derived Agent Images

An image derived from a NemoClaw agent image belongs to the release of its base image.
Rebuild it from the new release's base when you upgrade.
Refer to [derived agent images](../build-deploy/derived-images.md).

## Hand-Written HCL

Provider type names, inputs, and outputs can change between releases.
Each release's [provider guide](provider.md) and schema snapshots describe that release's types.

The examples under [`examples/hcl`](../../examples/hcl) are supported with the release they ship in: [`travel`](../../examples/hcl/travel/main.tf), which an integration scenario applies unchanged, and [`travel-team`](../../examples/hcl/travel-team/README.md).
Their resources follow the provider's [lifecycle rules](provider.md#openshell-resource-lifecycles), and destroy keeps what [deployment state](../build-deploy/state.md#understand-the-retained-resources) lists as retained.

## Import, Adoption, and State Backends

`tofu import` is not supported: every NemoClaw provider type reports "Import is not supported".
NemoClaw does not adopt resources it did not create.
It checks ownership labels and its saved bindings before changing anything.

The CLI and SDK keep each deployment's OpenTofu state in its local [state directory](../build-deploy/state.md).
Remote state backends are not supported for them.
Hand-written HCL can use any state backend OpenTofu supports, because the providers do not depend on the backend.
State holds resource identities and settings, never credential values.
Protect it like any OpenTofu state.
