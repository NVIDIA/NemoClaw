<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Review Image Licenses

Publishing a v1 image redistributes every component in it, so each image's licenses must allow that before a final release ([#13524](https://github.com/NVIDIA/NemoClaw/issues/13524)).
This page states when an image needs open-source review board (OSRB) sign-off, how to review a release's images, and the result for release candidate `v0.1.0-rc10`.

## When an Image Needs OSRB

An image needs no OSRB sign-off when every component's license allows redistribution with only its notices: MIT, Apache-2.0, BSD, ISC, and similar permissive licenses.
The image must still retain those notices.
An image needs OSRB sign-off when it contains any of these:

- a component under a third-party proprietary license;
- a component under a copyleft license, such as GPL, LGPL, AGPL, or MPL, whose source or notice terms apply;
- a component whose license is unknown or missing.

NVIDIA proprietary components, such as CUDA libraries, need no OSRB sign-off under this rule; their own license's redistribution terms still apply.

## Review a Release

1. Download every platform's SPDX asset and `sboms.json` from the release draft, as [SBOM assets](releases.md#sbom-assets) describes.
2. Classify each package by its declared license expression: take the most permissive choice of an `OR`, and the most restrictive term of an `AND`.
3. Resolve entries the SBOM marks `NOASSERTION` from their registry's metadata, such as [deps.dev](https://deps.dev) for Cargo, Go, npm, and PyPI packages, or from the upstream repository's license.
4. Inspect the image for components the SBOM can't see, such as executables bundled inside a package or libraries copied without package metadata.
5. Check that the image retains each component's license and notices, and record what each non-permissive component requires.

No release check applies this rule; review each final release's images by hand.

## Result for v0.1.0-rc10

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

## Limits of This Review

The scanner reads licenses from package metadata only, so it misses executables bundled inside packages, like the Claude Code CLI, and libraries copied without metadata, like Ollama's CUDA libraries.
It records no license for Cargo and Go entries; this review took them from deps.dev.
Workspace packages that npm never published, such as OpenClaw's and Hermes's own, take their repository's license.
JavaScript bundles built upstream, such as Hermes's dashboard and OpenClaw's `dist`, can include third-party code whose notices this review didn't check.
The proxy keeps the license files of every crate its `Cargo.lock` locks, including crates for other platforms that it doesn't link.
