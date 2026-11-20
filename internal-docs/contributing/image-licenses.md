<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reviewing Image Licenses

Publishing a v1 image redistributes every component in it, so each image's licenses must allow that before a final release ([#13524](https://github.com/NVIDIA/NemoClaw/issues/13524)).
This page records completed notice work, remaining release evidence, excluded images, and the historical review of release candidate `v0.1.0-rc10`.
A technical audit is evidence for a release decision; it does not authorize publication.

## Images Releases Don't Publish

Releases don't publish the `claude` image.
Its claude-agent-sdk wheels bundle the Claude Code CLI, which is Anthropic's proprietary software, "© Anthropic PBC. All rights reserved"; redistributing it needs Anthropic's permission, which NVIDIA doesn't have.
Staging takes its agent images from the Bake file's `release-agents` group, which leaves `claude` out, so a release doesn't push, list, assess, attest, or publish it.
CI still builds and checks the image, and users build it locally, as [Building Agent Images](../../docs/build-deploy/build.md#building-agent-images) describes.
The other images proceed through the review below.

## Release Approval Coverage

Before publication, the release owner must record the applicable container approval, inherited approval coverage, or exception with OSRB/Legal.
A permissive license classification alone does not establish that an image is approved for release.
Existing approved base or product coverage can reduce the review to additions and changes; a package or digest change does not by itself establish that a separate approval is required.
Keep private approval and contract details in the appropriate private review record.
CUDA and other proprietary components also need their applicable redistribution terms checked.

## Completed Notice Work

- [#14594](https://github.com/NVIDIA/NemoClaw/pull/14594) retains Node.js, OpenClaw, Bun, proxy dependency, and Rust library notices, and adds the initial review procedure.
- [#13590](https://github.com/NVIDIA/NemoClaw/pull/13590) adds per-platform software inventories (SBOMs) for release artifacts.
- [#14694](https://github.com/NVIDIA/NemoClaw/pull/14694) excludes Claude from release publication and documents local builds.
- The current recipes also retain the exact Codex 0.154.0 LICENSE and NOTICE, LangSmith 0.11.1 MIT notice, sqlite-vec 0.1.9 MIT notice, firecrawl-anydoc 0.2.4 MIT notice, and the Hermes dashboard's xterm.js 6.0.0 MIT notice.
  The llama.cpp overlay retains its two vendored UI library notices, pinned brand license and redistribution permission, source credit, and Geist font notice.
  Their source commits and checksums are pinned in `versions.json`; the image notice files describe their locations.

The current Ollama base's `GO_LICENSE` contains third-party Go module notices; do not repeat the historical missing-notice finding without inspecting the candidate.
The current Bun notice includes rebuilding instructions; retaining those instructions does not establish delivery of all required source or relinking materials.
Fabric's retained source archive includes Rust, Python, and Node attribution documents.
An attribution document or lockfile alone does not establish complete source delivery or an inventory of every compiled subcomponent.
Hermes's TUI bundle retains some inline attribution; its dashboard's notice coverage must be reconciled separately.
OpenClaw already ships the TypeScript source of `@ubjs/core` and MPL headers in `@ubjs/node`'s JavaScript wrapper.
Its CUA platform package retains `node-runtime-NOTICE.md`, which describes the modified MPL runtime and its source/build script; do not describe all UBJS source or CUA notice evidence as absent.

## Remaining Release Evidence

[#13524](https://github.com/NVIDIA/NemoClaw/issues/13524) tracks these requirements for the release owner and image maintainers.
There are 14 shipping image names: ten agents (`codex`, `deepagents`, `hermes`, `mini-swe-agent`, `nooa`, `nooa-bench`, `openclaw`, `opencode`, `pi`, and `remote-agent`), `ollama-proxy`, and three runtimes (`vllm`, `ollama`, and `llama-cpp`).
NIM is a separate local-build target, not part of this release catalog.

| Scope | Evidence still needed |
| --- | --- |
| Every shipping image | Applicable approval coverage; exact component versions, patches, notices, and source delivery tied to the final platform manifest digest |
| Debian and Ubuntu bases | Applicable inherited coverage or delivery of the exact required source packages and patches, with recipient instructions and retention ownership |
| Fabric, proxy, and native harness binaries | Build-specific dependency/source mapping, including native Codex and Code Mode binaries; source delivery beyond notice lists and lockfiles |
| Deep Agents and Hermes | Native wheel source coverage; Fetch Use 0.4.0's exact notice; original source and notices for Hermes's prebuilt dashboard and TUI |
| OpenClaw, Pi, and OpenCode | Shipped npm/native dependency mapping, including OpenClaw's MPL components and Bun's applicable source and relinking delivery |
| llama.cpp UI | Complete shipped JavaScript dependency/source/notice mapping beyond the named vendored libraries and brand assets already retained |
| Final runtime candidates | rc12 technical artifact checks are recorded below; complete the source/license reconciliation and repeat the artifact checks after notice fixes land |

The native-code follow-up has identifiable inputs:

- Codex's [Code Mode runtime manifest](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/code-mode-runtime/Cargo.toml) includes V8 and ICU data; the image ships `codex-code-mode-host` and a bundled `rg` in addition to `codex`.
  The project LICENSE and NOTICE do not establish a complete attribution inventory for these binaries.
- npm records `@ubjs/node` and its native platform package 0.31.0-3 at source commit [`dcb5c4ab`](https://github.com/jhugman/uniffi-bindgen-react-native/tree/dcb5c4ab2350d57f6d26f5fa81a99c77ed86d449).
  CUA 0.28.2's ARM64 npm provenance identifies commit [`36987990`](https://github.com/trycua/cua/tree/36987990b292537770fe2df3a9e6dee2ef43db2f), whose [runtime transformation script](https://github.com/trycua/cua/blob/36987990b292537770fe2df3a9e6dee2ef43db2f/libs/cua-driver/scripts/build-node-runtime.mjs) implements the change described in the retained notice.
  Reconcile each shipped platform binary and deliver the corresponding source under the selected release mechanism.
- Pi's installed npm tree includes Linux, macOS, and Windows native prebuilds.
  Account for all redistributed files, even when the Linux image does not execute them.

For the current vLLM 0.34.0 base, FFmpeg 8.1.1 is bundled through PyNvVideoCodec 2.0.4 and OpenCV, rather than PyAV.
Their retained notices identify LGPL terms; reconcile each actual library and build with its corresponding source.
A scanner's unknown license entry alone does not establish a missing notice or a redistribution prohibition.

For source delivery, identify the image path or release-controlled source location, exact versions and patches, any required build/relinking materials, recipient instructions, and the owner and retention period.
Upstream links alone do not establish that the selected delivery mechanism meets the applicable requirements.
Reuse complete source and notices already retained, including the supervisor's vendor archive and pure source packages.
Only applicable third-party source obligations are in scope; this does not require publication of proprietary CUDA source.

For harnesses NVIDIA does not ship, document compatible pinned builds and inherited notice, source, and service terms.
Local building does not itself grant permission to redistribute the result.

## rc12 Runtime Artifact Evidence

Release candidate `v0.1.0-rc12` was staged from `1636069b91f402242a35714fde1011042c3f1f70`.
All six runtime platform manifests were retrieved by digest; their SPDX assets match `sboms.json`, and each SPDX document describes that exact platform digest.
Their layer prefixes match the six upstream base artifacts already inspected.
The 13 distinct added layers, totaling 81,079,483 compressed bytes, were downloaded, SHA-256 verified, and indexed with whiteouts applied.

| Runtime | AMD64 Platform Digest | ARM64 Platform Digest |
| --- | --- | --- |
| vLLM | `sha256:c57f93323a4ffbcc3fe4460b3b7a065c7c1bbb3a3e563f51934ba42a97907a0c` | `sha256:122e7bd54c502380b57e488bc7209ddb0052ddbb59cabdf57d96405fadf5d6c3` |
| Ollama | `sha256:9b9c6ab3fbf5518bb751abb5514853d4121ff33dcc383f671ef121832fdda6ea` | `sha256:4e31e854a00220fad6eaf11aa54203e0fff7ca383f3da4fb2dbfb1f2860cfdb6` |
| llama.cpp | `sha256:627d5433b61de101fb851ff722e0120a697c4ec73ca14664fa557c822ddacc98` | `sha256:f4e683cc2ae24e8cae9ecf3c4a0ade4876bcdcea4f8693f1fff8c15dc982e445` |

All six retain the same `supervisor-source.tar.gz`, SHA-256 `17f009964ab6805a28992cb094f036479a396037bce72e191209be1c40c7cf4e`.
It contains the supervisor's Rust source, build configuration, and 268 vendored crate manifests across 20,132 archive entries.
The Rust library notice and supervisor lockfile are also retained.
Both llama.cpp overlays retain all five pinned C++ license files.
Credit this evidence when preparing source delivery; do not request the supervisor's vendored sources again.

These checks establish the inspected contents of rc12, not complete license compliance, approval, or GPU qualification.
rc12 predates the additional notice fixes on this page; final post-fix candidates must be checked again.
The remaining source, native/frontend attribution, and redistribution-term requirements still apply.

## Reviewing a Release

1. Download every platform's SPDX asset and `sboms.json` from the release draft, as [SBOM assets](releases.md#sbom-assets) describes.
2. Classify each package by its declared license expression: take the most permissive choice of an `OR`, and the most restrictive term of an `AND`.
3. Resolve entries the SBOM marks `NOASSERTION` from their registry's metadata, such as [deps.dev](https://deps.dev) for Cargo, Go, npm, and PyPI packages, or from the upstream repository's license.
4. Inspect the image for components the SBOM can't see, such as executables bundled inside a package or libraries copied without package metadata.
5. Check that the image retains each component's license and notices, and record applicable source, relinking, and redistribution requirements.
6. Record the source delivery mechanism and applicable approval coverage against each final platform manifest digest.

No automated license gate establishes these release decisions; review each final release's images.

## Result for v0.1.0-rc10

This is a historical technical assessment, not current release approval.
The verdicts and gaps below describe rc10; use [Remaining Release Evidence](#remaining-release-evidence) for current closeout work.
The historical proxy verdict describes permissive license findings, not an exemption from container approval.

This review covers both platforms of every image that `v0.1.0-rc10` staged from [`5716c39`](https://github.com/NVIDIA/NemoClaw/commit/5716c39bc26a16532033d1e4c6e44636fe7aa983).
Images built from later commits, such as the vLLM 0.34.0 and Hermes Agent 0.22.7 upgrades, need their own review.

| Image | Result | OSRB needs to review |
|---|---|---|
| `claude` | Needs OSRB | The Claude Code CLI under Anthropic's proprietary terms; Debian packages under GPL and LGPL; certifi under MPL-2.0 |
| `codex`, `nooa`, `nooa-bench`, `remote-agent`, `pi` | Needs OSRB | Debian packages under GPL and LGPL; certifi under MPL-2.0 |
| `deepagents` | Needs OSRB | Debian packages; certifi, orjson, and tqdm under MPL-2.0 |
| `mini-swe-agent` | Needs OSRB | Debian packages; certifi and tqdm under MPL-2.0 |
| `hermes` | Needs OSRB | Debian packages; certifi, pathspec, and tqdm under MPL-2.0 |
| `openclaw` | Needs OSRB | Debian packages; certifi and eight npm packages under MPL-2.0 |
| `opencode` | Needs OSRB | Debian packages; certifi under MPL-2.0; Bun's statically linked JavaScriptCore and TinyCC under LGPL-2.1 |
| `ollama-proxy` | Redistributable | Nothing: every component is permissive; images built with this page's change retain their notices, which the rc10 image lacks |
| `vllm` | Needs OSRB | Ubuntu packages; Python packages under GPL, LGPL, and MPL-2.0; Rust crates under MPL-2.0 in uv; FFmpeg and other components of unknown license |
| `ollama` | Needs OSRB | Ubuntu packages under GPL and LGPL |

### Counts by License Family

Each package counts once across both platforms, in the family of its most restrictive license.
Debian and Ubuntu packages count by every license their copyright file names, including licenses that cover only build scripts or documentation, so the counts overstate copyleft code in them.

| Image | Packages | Permissive | Weak copyleft | Strong copyleft | NVIDIA proprietary | Unknown |
|---|---|---|---|---|---|---|
| `claude` | 149 | 53 | 3 | 81 | 0 | 12 |
| `codex` | 132 | 36 | 3 | 81 | 0 | 12 |
| `deepagents` | 195 | 97 | 5 | 81 | 0 | 12 |
| `hermes` | 386 | 267 | 5 | 95 | 0 | 19 |
| `mini-swe-agent` | 194 | 97 | 4 | 81 | 0 | 12 |
| `nooa` | 127 | 31 | 3 | 81 | 0 | 12 |
| `nooa-bench` | 127 | 31 | 3 | 81 | 0 | 12 |
| `openclaw` | 1143 | 1017 | 12 | 95 | 0 | 19 |
| `opencode` | 510 | 413 | 4 | 81 | 0 | 12 |
| `pi` | 490 | 394 | 3 | 81 | 0 | 12 |
| `remote-agent` | 130 | 34 | 3 | 81 | 0 | 12 |
| `ollama-proxy` | 77 | 77 | 0 | 0 | 0 | 0 |
| `vllm` | 1557 | 1082 | 48 | 212 | 25 | 190 |
| `ollama` | 449 | 341 | 2 | 74 | 0 | 32 |

Weak copyleft covers LGPL, MPL, and similar file- or library-scoped licenses; strong copyleft covers GPL and AGPL.
Every unknown entry in the agent images is a Debian package; 187 of vLLM's and 31 of Ollama's are Ubuntu packages, and Ollama's other one is Ollama's own MIT-licensed module.

### Components That Need Attention

#### Debian and Ubuntu Packages

Every image except `ollama-proxy` contains an operating system: Debian 13 in the agent images and Ubuntu in the runtime images.
In the agent images, 81 Debian packages name a GPL license, such as bash, coreutils, and the GNU C Library, and 2 more an LGPL license; the Hermes and OpenClaw images, which add Git and Perl, have 95 under GPL.
GPL and LGPL require that recipients can obtain the corresponding source of the exact package versions, through source shipped alongside or a written offer.
Each image keeps the packages' copyright files under `/usr/share/doc` and the license texts under `/usr/share/common-licenses`, which covers their notice terms.
OSRB decides whether Debian's and Ubuntu's own source archives satisfy the source terms or the release must publish the sources itself.
Twelve Debian packages in every agent image have copyright files the scanner can't parse: `debian-archive-keyring`, `gcc-14-base`, `libcrypt1`, `libgcc-s1`, `libgssapi-krb5-2`, `libk5crypto3`, `libkrb5-3`, `libkrb5support0`, `liblzma5`, `libstdc++6`, `libxtables12`, and `perl-base`.
The Hermes and OpenClaw images add `libgnutls30t64`, `libldap2`, `libperl5.40`, `librtmp1`, `libtasn1-6`, `perl`, and `perl-modules-5.40`.

#### MPL-2.0 Packages in the Agent Images

| Package | Images | Form |
|---|---|---|
| certifi 2026.10.19 | Every agent image | Python source |
| tqdm 4.68.3 or 4.70.0 (MPL-2.0 and MIT) | `deepagents`, `mini-swe-agent`, `hermes` | Python source |
| orjson 3.11.9 (MPL-2.0, Apache-2.0 or MIT) | `deepagents` | Compiled extension |
| pathspec 1.1.1 | `hermes` | Python source |
| @novnc/novnc 1.7.0, @ubjs/core, @ubjs/node and its platform package 0.31.0-3, mediabunny 1.58.0, web-push 3.6.7 | `openclaw` | JavaScript source and a native addon |
| @trycua/cua-driver 0.28.2 platform package (MIT and MPL-2.0) | `openclaw` | Native executable |

MPL-2.0 requires that recipients of an executable form can obtain the source of the MPL-covered files, and that the license notice stays with them.
Packages installed as Python or JavaScript source carry their source, and their package directories keep the license.
The compiled orjson extension, the @ubjs native addon, and the cua-driver executable need a source offer that OSRB confirms.

#### Claude Code CLI in `claude`

The image installs claude-agent-sdk 0.2.166, which is MIT-licensed, and its Linux wheels bundle the Claude Code CLI at `claude_agent_sdk/_bundled/claude`.
The SBOM lists only the SDK.
Claude Code is "© Anthropic PBC. All rights reserved", and the SDK's own documentation places its use under Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).
Redistributing that executable in a published image needs OSRB to confirm that Anthropic's terms allow it.
Releases after `v0.1.0-rc11` leave the image out instead; see [Images Releases Don't Publish](#images-releases-dont-publish).

#### Bun in `opencode`

Bun 1.4.4 is MIT-licensed and statically links JavaScriptCore and TinyCC under LGPL-2.1, as [its license](https://github.com/oven-sh/bun/blob/bun-v1.4.4/LICENSE.md) states.
LGPL-2.1 requires that recipients can relink a statically linked executable against a modified library; Bun publishes its [patched WebKit](https://github.com/oven-sh/webkit) and its relinking instructions for that.
The SBOM lists Bun without a license, and Bun's image carries no license file.

#### vLLM Image

- python-apt (GPL) and the LGPL Python packages autocommand, launchpadlib, lazr.restfulclient, lazr.uri, pycountry, PyGObject, and wadllib: GPL and LGPL source terms.
- certifi and tqdm, and the uv executable's crates astral-pubgrub, astral-version-ranges, option-ext, and priority-queue (MPL-2.0 or LGPL-3.0): MPL-2.0 source terms.
- FFmpeg 8.1.1, which PyAV bundles, without a license in the SBOM: FFmpeg is LGPL-2.1 or GPL depending on its build options, which OSRB needs to establish.
- A Go library built as `command-line-arguments` on AMD64 and a `utils` entry without package metadata: unknown licenses.
- 24 NVIDIA Python packages, such as cuBLAS, cuDNN, NCCL, and the CUTLASS DSL, and the `cuda-compat-13-0` package: NVIDIA's license terms, outside OSRB, though `cuda-compat-13-0` also names GPL-2.0.

#### Ollama Image

- The Ubuntu packages, and `libgomp` in `/usr/lib/ollama` under GPL-3.0 with the GCC Runtime Library Exception.
- cuBLAS, cuBLASLt, and the CUDA runtime in `/usr/lib/ollama/cuda_*`, which the SBOM doesn't list: NVIDIA's license terms, outside OSRB.
- The Go modules compiled into `ollama` are MIT, BSD, Apache-2.0, or ISC; the upstream image keeps the Go, llama.cpp, and cpp-httplib licenses in `/usr/lib/ollama` but not the Go modules' notices.

#### llama.cpp Image

`v0.1.0-rc10` didn't stage this image, so its first release review classifies its SBOM.
Beyond the Ubuntu packages, these need attention:

- FFmpeg 6.1.1 from Ubuntu, with x264 and x265, which the base image installs: GPL source terms.
- The CUDA 13.5 libraries: NVIDIA's license terms, outside OSRB; the image keeps the CUDA EULA at `/usr/local/cuda-13.5/EULA.txt`.
- The JavaScript packages that the web interface built into `llama-server` bundles: notices not checked.

llama.cpp and the other libraries its server compiles in are MIT, BSD-2-Clause, MIT-0, or public domain.

#### Rust Executables

The proxy's and the supervisor's crates are permissive; [`deny.toml`](../../deny.toml) allows only permissive licenses for the workspace, and deps.dev confirms each crate in the SBOMs.
The supervisor's source archive keeps its crates' license files.

## Notices

| Notice | Finding | Change |
|---|---|---|
| [Agent image sources](../../image/NOTICE.md) | The images drop Node.js's license, which carries the notices of the libraries its executable bundles | The `hermes`, `openclaw`, and `pi` images keep it at `/usr/local/share/doc/node/LICENSE` |
| [Agent image sources](../../image/NOTICE.md) | OpenClaw's published image, which supplies `/app`, omits OpenClaw's MIT license | The `openclaw` image keeps the license from OpenClaw's 2026.9.34 release at `/opt/nemoclaw/source/openclaw-LICENSE` |
| [Agent image sources](../../image/NOTICE.md) | Bun's image omits Bun's license | The `opencode` image keeps Bun 1.4.4's license at `/opt/nemoclaw/source/bun-LICENSE.md` |
| [Agent image sources](../../image/NOTICE.md) | The Claude Code CLI's terms aren't recorded | The notice names the bundled CLI and its terms |
| [Hermes image source](../../image/fabric/HERMES-NOTICE.md) | `/opt/hermes` keeps Hermes's MIT license, and the Switchyard bundle keeps its own | None |
| No notice | The proxy keeps only its own license and `Cargo.lock`, not the notices of the crates, Rust standard library, and musl it links | The proxy keeps each locked crate's license files and manifest under `/usr/share/doc/nemoclaw-ollama-proxy/dependencies`, and Rust's library notices, which include musl's, in `rust-COPYRIGHT-library.html` beside them |
| [vLLM runtime](../../image/vllm/NOTICE.md), [Ollama runtime](../../image/ollama/NOTICE.md) | The supervisor archive keeps its crates' notices but not the Rust standard library's | Both images keep `/opt/nemoclaw/source/rust-COPYRIGHT-library.html` |
| [llama.cpp runtime](../../image/llama-cpp/NOTICE.md) | llama.cpp's image omits llama.cpp's MIT license and the licenses of the libraries its server compiles in | The `llama-cpp` image keeps them in `/opt/nemoclaw/source/`, and the supervisor's Rust library notices |

## Limits of This Review

The scanner reads licenses from package metadata only, so it misses executables bundled inside packages, like the Claude Code CLI, and libraries copied without metadata, like Ollama's CUDA libraries.
It records no license for Cargo and Go entries; this review took them from deps.dev.
Workspace packages that npm never published, such as OpenClaw's and Hermes's own, take their repository's license.
JavaScript bundles built upstream, such as Hermes's dashboard and OpenClaw's `dist`, can include third-party code whose notices this review didn't check.
The proxy keeps the license files of every crate its `Cargo.lock` locks, including crates for other platforms that it doesn't link.
