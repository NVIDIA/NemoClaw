<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell 0.0.72 to 0.0.82 migration review

## Status and decision

This is a candidate migration review, not approval to ship OpenShell 0.0.82.
The reviewed upstream endpoint is OpenShell `main` at
[`bb72d0123c748ed7e209880f7bab593e10aae221`](https://github.com/NVIDIA/OpenShell/commit/bb72d0123c748ed7e209880f7bab593e10aae221).
OpenShell has not published a stable `v0.0.82` tag or release at this endpoint.
NemoClaw therefore remains pinned to `0.0.72` until the final release identity,
semantic migrations, artifact provenance, supported-platform proofs, and DGX Spark
credential-substitution proof below are complete.

The source under review includes
[`40194f935ef6e29cb07500b9109314778ab6915c`](https://github.com/NVIDIA/OpenShell/commit/40194f935ef6e29cb07500b9109314778ab6915c),
which prevents a credential placeholder from leaving the proxy unresolved. That
change fails closed when the resolver or TLS-termination state is missing; it does
not prove that the affected DGX Spark host can initialize that state and complete a
real credential-bearing MCP call. NVIDIA/NemoClaw#6379 remains open until the
physical Docker 27 DGX Spark reproducer reports honest status and completes a real
MCP tool call with credential substitution.

## Audit method and exact boundary

The current identity is OpenShell `v0.0.72` at
`8cb16de9eae4c44d7d31e1493747d8c10abb5963`. The candidate identity is the exact
remote `main` SHA above, not a local branch name or the moving `dev` tag.

The audit enumerated every stable adjacent tag, then read the release notes,
complete commit list, changed paths, source diffs, and upstream tests for each
range. Release notes were treated as leads rather than proof. The resulting boundary
contains 10 adjacent ranges, 46 commits, and 174 distinct changed paths in the
aggregate `v0.0.72..bb72d012` comparison.

The ledger was produced with:

```bash
collect-release-ledger.py \
  --repo <read-only-openshell-checkout> \
  --from v0.0.72 \
  --to origin/main
```

| Range | Commits | Changed paths | Diff size |
|---|---:|---:|---:|
| `v0.0.72 -> v0.0.73` | 5 | 27 | +1,530 / -531 |
| `v0.0.73 -> v0.0.74` | 6 | 25 | +328 / -163 |
| `v0.0.74 -> v0.0.75` | 2 | 26 | +3,416 / -5 |
| `v0.0.75 -> v0.0.76` | 3 | 28 | +2,267 / -201 |
| `v0.0.76 -> v0.0.77` | 3 | 7 | +452 / -27 |
| `v0.0.77 -> v0.0.78` | 6 | 23 | +198 / -115 |
| `v0.0.78 -> v0.0.79` | 1 | 1 | +1 / -1 |
| `v0.0.79 -> v0.0.80` | 5 | 15 | +1,373 / -96 |
| `v0.0.80 -> v0.0.81` | 4 | 9 | +617 / -24 |
| `v0.0.81 -> bb72d012` | 11 | 75 | +7,850 / -982 |

Release publication is a separate gate from source ancestry:

- `v0.0.73` through `v0.0.80` have published GitHub releases.
- The `v0.0.79` release notes repeat the `v0.0.78` change list and add only the
  `setup-uv` bump. The adjacent Git diff, not that cumulative note body, is the
  source of truth for the `v0.0.78 -> v0.0.79` range.
- `v0.0.81` is a source tag at `420a855ddc21a20ac528f902bd2ed7f3fc133dc9`,
  but it has no GitHub release. Release Tag run
  [29101552146](https://github.com/NVIDIA/OpenShell/actions/runs/29101552146)
  failed the Ubuntu 26.04 rootless-Podman E2E job and skipped publication.
- OpenShell `bb72d012` produced a successful Release Dev run
  [29215426930](https://github.com/NVIDIA/OpenShell/actions/runs/29215426930),
  but it does not expose one interchangeable version string. The released CLI,
  gateway, and standalone sandbox binaries report `0.0.82-dev.11+gbb72d012`;
  the pipeline Cargo version and supervisor image report
  `0.0.82-dev.11+gbb72d0123`; and Python wheel filenames use
  `0.0.82.dev11+gbb72d0123`. Development compatibility manifests must record
  the observed CLI output separately from producer and component versions. A
  moving prerelease is useful for compatibility work, but is not a stable
  selector or final provenance record.

### Rust dependency and notice delta

The aggregate `Cargo.lock` comparison is 48 additions and 25 removals. Its only
new third-party package identities are `capctl 0.2.4`, checksum
`4a6e71767585f51c2a33fed6d67147ec0343725fc3c03bf4b89fe67fede56aa5`,
and its `bitflags 1.3.2` dependency, checksum
`bef38d45163c2f1dde094a7dfd33ccf595c92905c8f8f4fdc18d06fb1037718a`.
The exact production path is `bitflags 1.3.2 -> capctl 0.2.4 ->
openshell-supervisor-process -> openshell-sandbox`. `afc06dd2` uses
`capctl::caps::bounding::{clear, probe, clear_unknown}` for the new capability
bounding-set behavior, so this is security-boundary code rather than an
incidental build dependency.

The retained crates.io `capctl` source identifies upstream Git commit
`6b89ddb3e79493a5e34bb681c00053d6122968bd`, is MIT-licensed, and has no build
script. Its implementation contains unsafe FFI around Linux `prctl`, `capget`,
`capset`, and extended-attribute operations. `bitflags 1.3.2` identifies upstream
Git commit `ed185cfb1c447c1b4bd6ac021c9ec3bb02c9e2f2` and is dual
MIT/Apache-2.0. A read-only RustSec advisory-database search on July 12, 2026
found no advisory entry naming `capctl`; that absence is inventory evidence, not
proof that the unsafe boundary is vulnerability-free.

OpenShell's `THIRD-PARTY-NOTICES` object is byte-identical at `v0.0.72` and
`bb72d012` (`41eda0e0a83429e874544b507977c3a56f5a489f`). It does not name
`capctl` and still records only `bitflags 2.10.0`, while the candidate lock has
`bitflags 1.3.2` and `2.11.1`. OpenShell has source-directory CycloneDX tooling,
but its license check is advisory and the candidate release job neither
generates nor publishes that SBOM. The release job attests VM-driver archives,
not the consumed CLI, gateway, standalone sandbox archives, or supervisor OCI
image. Final approval therefore requires a lock-to-binary dependency inventory,
current notices/licenses, advisory results, and provenance for the stable
artifacts; the unchanged notice cannot be treated as evidence that the Rust
dependency graph stayed constant.

## Artifact baseline and provenance gap

The currently shipped `0.0.72` supervisor index
`sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d`
resolves to these exact platform identities:

| Platform | Child manifest | Config |
|---|---|---|
| Linux amd64 | `sha256:e97174326ee25c896117e854c791945d0c458a26bc9d6eab004ccd6c19d86ee7` | `sha256:b34f500c495871bf92d8a04011a210167e95f3650927b3bd67dde3ddcc021ac2` |
| Linux arm64 | `sha256:0679e02da0bd480a3e2f119dc2d205269336c9c01d7d2c8f18d05400f89d160e` | `sha256:e53f2ac5b7b3667833271f62f053887d2be9f223d2699b7e39f88c78fd9df373` |

Both child configs set `/openshell-sandbox` as the entrypoint but expose no OCI
source labels. A read-only registry audit on July 12, 2026 found that GHCR
returned no referrers index for the shipped manifest and that all 2,905
supervisor tags contained no digest-derived signature, attestation, or SBOM tag
for that index. Therefore `0.0.72` has no verifiable source-to-image attestation;
matching release tags or timestamps cannot fill the gap. The immutable index
digest is the strongest enforceable runtime control for the baseline, while the
child manifest and config identities above are audit evidence rather than source
provenance. The final `0.0.82` artifact audit must verify any upstream OCI
attestation and source labels that are actually published, or explicitly retain
this provenance gap as an unresolved supply-chain gate. NemoClaw cannot
manufacture a missing upstream attestation.

NemoClaw now validates the shape of every consumed OpenShell archive before any
extraction: the asset must contain exactly one regular file with the expected
CLI, gateway, or sandbox binary name. Absolute paths, parent traversal, extra or
duplicate members, links, and devices fail closed. This structural validation is
independent of release SHA-256 verification and also constrains the explicitly
unverified development-channel path.

### Candidate development artifact evidence

The successful `bb72d012` Release Dev run provides bounded compatibility inputs,
not release approval. The exact retained Linux amd64 artifacts inspected on July
12, 2026 are:

| Role | Actions artifact | Actions ZIP SHA-256 | Inner archive SHA-256 | Extracted binary SHA-256 |
|---|---|---|---|---|
| CLI | `8266446648` (`cli-linux-amd64`) | `78923b27a492204b6e869d9f5f392e57b37d8ddcb9367d746f4ee46cfaf0e5a2` | `d1732c0b87801560afd1b06cfea31c60d6a357100d5b817b4a4fb181b0b71933` | `09083ef8087e5191fc3513a7239b08041b511fdeb7f2fe074bdf8820886cbea1` |
| Gateway | `8266452366` (`gateway-binary-linux-amd64`) | `39504758f07a8bac0a52d958ec56e380ac59824bde8db72a815a9b82c6bbcfd6` | `5e3728564b1f965cb5d320bab4f37d388303723f42a64c308227dbc1ef382043` | `39e75f7a2a96c220e3f2d645067f0623d922385ade07edb2037a27cc07ea81d1` |
| Standalone sandbox | `8266435047` (`supervisor-binary-linux-amd64`) | `7b2e47adbbfc644806b465a4f4c3c7bfaba7117e1f19ec9f151b37695b418bf4` | `6f7040e89ec249df7f3b36ddff609a87f096fcdf62cd5c28e86757f175e40a7a` | `58e5d99261d2b8ea06664d020995830fd3f153ea692f36622b92f9b827ea60c8` |

Each Actions ZIP contains exactly the expected archive, and each nested archive
contains exactly one regular mode-0755 root-owned binary with no links or extra
paths. The artifacts expire around July 18, 2026; their IDs are evidence only
while retained and must not become long-lived dependency selectors.

The development supervisor image resolves to immutable index
`sha256:fc441051102b1a16ffcabf59878fa464d3c548f29bfbfa6e4acb232ab67198b7`:

| Platform | Child manifest | Config | Binary layer | `/openshell-sandbox` SHA-256 |
|---|---|---|---|---|
| Linux amd64 | `sha256:4a54b434decd007d2a966edb5db751adb3ca4cf8ab8ac0b248901f8efe614b71` | `sha256:5432194fa43840c333bc7b166bf6e7c0e15247e9dc195cb9a38c1a85b7415f44` | `sha256:d1baeaebaddef6291e0a94b697f28c3c319ac2ec1a83843026e89553cc7cd27e` | `8e89067afca2d1c02a25fb19906dd27fd8d524ee4eb3b2b36b1210338dae9235` |
| Linux arm64 | `sha256:fab8d5c551991648a19bf7876d2edf19fdcf4e95139ce5f75d638354c0820d51` | `sha256:66a1d121d6386e19297d05a950ba7409c5752f337bacfbc156c7c76513e40136` | `sha256:818c727cb5cbcdb78918a274ca6b9aa85be6a95fdb604e49f523cf2c87f2eba4` | `8ec9b88c49f001d070ada7bb5a98fb6f96498fc446b0f2f614056247d7300b85` |

Read-only package-database inspection of both development child manifests found
Alpine `3.22.5` and the same 29 installed APK records:

```text
alpine-baselayout-3.7.0-r0       alpine-baselayout-data-3.7.0-r0
alpine-keys-2.5-r0               alpine-release-3.22.5-r0
apk-tools-2.14.10-r0             busybox-1.37.0-r20
busybox-binsh-1.37.0-r20         ca-certificates-bundle-20260611-r0
gmp-6.3.0-r3                     iptables-1.8.11-r1
iptables-legacy-1.8.11-r1        jansson-2.14.1-r0
libapk2-2.14.10-r0               libcrypto3-3.5.7-r0
libip4tc-1.8.11-r1               libip6tc-1.8.11-r1
libmnl-1.0.5-r2                  libncursesw-6.5_p20250503-r0
libnftnl-1.2.9-r0                libssl3-3.5.7-r0
libxtables-1.8.11-r1             musl-1.2.5-r12
musl-utils-1.2.5-r12             ncurses-terminfo-base-6.5_p20250503-r0
nftables-1.1.3-r0                readline-8.2.13-r1
scanelf-1.3.8-r1                 ssl_client-1.37.0-r20
zlib-1.3.2-r0
```

The installed package metadata spans MIT, Apache-2.0, GPL-2.0-only,
GPL-2.0-or-later, GPL-3.0-or-later, LGPL-2.1-or-later,
LGPL-3.0-or-later, MPL-2.0, BSD-2-Clause, X11, and Zlib expressions. The image
contains no path whose name matches `LICENSE`, `COPYING`, or `NOTICE`. On amd64,
the filesystem inventory has 152 mode-executable regular files, including 115
xtables modules, plus 391 symbolic links and 304 BusyBox applets. Those counts
include executable-mode shared objects; they deliberately describe the whole
distributed filesystem rather than only the three explicitly installed package
names.

The source Dockerfile uses mutable `alpine:3.22` and resolves unversioned
`nftables`, `iptables`, and `iptables-legacy` packages at build time. The build
wrapper passes `--provenance=false`. The development digest freezes the result
inspected above, but the Dockerfile alone cannot reproduce that result or bind
the resolved base/package identities to source.

This expanded image is not all executable runtime surface for NemoClaw's Docker
driver. OpenShell pulls the image, creates a non-running extractor container,
downloads only `/openshell-sandbox`, caches that binary by image content ID, and
bind-mounts it into the actual sandbox image. The Alpine packages are therefore
downloaded supply-chain and local-daemon storage surface, but are not executed in
the standard NemoClaw Docker topology. OpenShell's Kubernetes sidecar and Podman
image-volume paths can execute or expose the Alpine filesystem; those drivers
remain outside the current NemoClaw integration. Both boundaries must be stated:
the Docker extraction behavior narrows runtime exposure, but it does not make an
unreproducible, unattributed distributed layer disappear.

Those image binaries byte-match build artifacts `8266448422` (amd64) and
`8266451406` (arm64), respectively. The match binds registry content to retained
Actions output, but not cryptographically to source: GitHub returned no
attestation for the index or either child manifest, and the OCI configs expose no
source, revision, or version labels. Development proof must therefore record
`attestationStatus: absent`, preserve every digest above, and avoid claiming
source-to-image provenance. The final stable release must be audited anew rather
than inheriting this development evidence.

## Adjacent release findings

### v0.0.72 to v0.0.73

Commits: `afc06dd2`, `a5161d0b`, `a2268060`, `f27ff150`, `474d2d4a`.

- `afc06dd2` clears the full Linux capability bounding set for entrypoint, exec,
  and connect children. Child launch fails when `CAP_SETPCAP` is unavailable and
  the bounding set is nonempty; it succeeds without that capability only when the
  runtime already supplied an empty bounding set. This directly intersects
  NemoClaw's Docker Desktop, WSL, Colossus, cloud, and DGX capability workarounds.
  The implementation also adds the `capctl 0.2.4 -> bitflags 1.3.2` dependency
  chain audited above; runtime behavior and dependency provenance are separate
  gates.
- `a5161d0b` moves selected-driver configuration acquisition into a normalized
  server path. NemoClaw renders an authenticated Docker TOML containing the
  selected driver, TLS, mTLS, JWT, supervisor image, and supervisor binary; the
  final OpenShell binary must parse that exact rendered file and preserve both
  listener paths across restart and legacy-gateway upgrade.
- `f27ff150` reserves credential names matching `v<digits>_<key>`, introduces
  revision-scoped child placeholders, retains eight resolver generations, and
  falls an evicted revision back to the current credential only when that key
  still exists. NemoClaw must reject the reserved namespace and prove rotation,
  removal, restart, and rebuild behavior rather than assuming the old unversioned
  placeholder contract.
- `a2268060` changes only upstream GPU E2E fixture execution and `474d2d4a`
  changes contributor documentation. They add no consumed runtime contract.

### v0.0.73 to v0.0.74

Commits: `ed0026aa`, `0a25fdf5`, `5477e2f2`, `914da339`, `450685c7`, `45614a3f`.

- `0a25fdf5` removes the unused gateway `extra_bind_addresses` configuration.
  NemoClaw does not emit that field, but must parse its final Docker TOML and prove
  the intended loopback and Docker-bridge reachability instead of relying on that
  absence alone.
- `450685c7` rejects leading/trailing whitespace in mount fields. NemoClaw does
  not configure production driver mounts; the test-only EXDEV tmpfs mount is the
  downstream consumer and remains a required no-impact regression.
- The Helm SAN, MCP documentation, Kubernetes combined-topology, and removed raw
  `SandboxTemplate.volume_claim_templates` changes are not consumed by NemoClaw's
  Docker gateway or CLI integration. NemoClaw has no raw OpenShell protobuf client
  for the removed field.

### v0.0.74 to v0.0.75

Commits: `abcd15d1`, `45060f44`.

Envoy Gateway TLS termination and the Gator agent manifest are native OpenShell
Kubernetes/agent surfaces. NemoClaw neither deploys that Helm topology nor selects
the Gator manifest, so these are evidence-backed exclusions from the Docker
dependency migration.

### v0.0.75 to v0.0.76

Commits: `43bb0302`, `5f9bf9ce`, `6461677c`.

- `43bb0302` changes Docker and Podman bind mounts to support SELinux relabeling,
  explicit source checks, and Docker's legacy bind representation. Production
  NemoClaw supplies no driver mounts; the EXDEV fixture remains the direct test.
- `6461677c` adds numeric UID/GID policy identities and configurable Kubernetes
  and VM identities. NemoClaw's supported gateway configuration selects only the
  Docker driver; that driver does not inject the new UID/GID environment or
  consume the VM fields, so the downstream Docker process remains the named
  `sandbox` identity. This is a Docker-only exclusion, not a claim that the
  upstream change is merely additive on every driver.
- The VM default remains its legacy hardcoded UID/GID `10001`, and prepared-image
  cache identities include the rootfs layout, OpenShell version, and source-image
  identity. Upgrading from `0.0.72` therefore misses the old cache. Within one
  OpenShell version, however, the cache identity omits resolved `sandbox_uid` and
  `sandbox_gid`; changing those settings can reuse a rootfs whose passwd/group
  entries were baked for the old identity. Any future NemoClaw VM-driver support
  must include those values in the key or purge and rebuild the cache.
- The rootless-Podman host E2E change does not alter NemoClaw's Docker runtime.

### v0.0.76 to v0.0.77

Commits: `f852d07b`, `6252aa17`, `31807d68`.

This range contains Hermes support documentation, an unimplemented driver-config
passthrough RFC, and a workflow action bump. It adds no shipped contract consumed
by NemoClaw.

### v0.0.77 to v0.0.78

Commits: `5656240c`, `290297ff`, `9c14de7b`, `eba5dd75`, `abe42fb5`, `a7271169`.

The Podman sandbox-JWT secret delivery fix is outside NemoClaw's Docker path.
The remaining changes are documentation or removal of deprecated `--keep`
references; NemoClaw does not invoke `--keep`.

### v0.0.78 to v0.0.79

Commit: `f7aa3aa3`.

Only `astral-sh/setup-uv` changed. There is no runtime or packaging selector
consumed by NemoClaw in this adjacent range, despite the cumulative `v0.0.79`
release-note body listing older changes.

### v0.0.79 to v0.0.80

Commits: `2e2b497f`, `ed8ce820`, `5207f118`, `ff9af8e3`, `709aa0fe`.

- `ff9af8e3` acknowledges the exact initially loaded sandbox policy revision and
  reconciles an initial mismatch instead of leaving version zero/pending state.
  `run_policy_status_reporter` consumes an unbounded FIFO independently of the
  enforcement loop and retries a retryable head item forever, with backoff capped
  at 32 seconds. Policy enforcement therefore continues, but an older unavailable
  acknowledgement can head-of-line block every later status. The separate
  construction-failure path makes five best-effort report attempts and then
  preserves the startup error. Upstream unit coverage proves matching, mismatched,
  global, version-zero, local-override, provider-composed, unbound, and 128-item
  FIFO cases; its live test proves a sparse initial revision becomes loaded. It
  does not isolate report-RPC outage/recovery or force initial policy construction
  failure. NemoClaw must therefore prove the observable success path and retain
  the two fault paths as explicit gates; `policy set --wait` alone is insufficient
  evidence.
- The Podman import fix, Docker-version typo, man-page date, and setup action bump
  do not change the consumed Docker runtime contract.

### v0.0.80 to v0.0.81

Commits: `83131d7e`, `88710225`, `49701088`, `420a855d`.

NemoClaw does not call `provider refresh configure
--secret-material-env`. Telemetry documentation and Packit target changes are
not consumed. `420a855d` adds upstream supervisor proxy-hostname regression tests
without changing product source. The failed stable publication is nevertheless a
hard artifact gate for this source tag.

### v0.0.81 to candidate main bb72d012

Commits: `5f38b7c4`, `ccdac9ce`, `caaa5165`, `8c0ecac8`, `233d207e`,
`10702133`, `bebf440b`, `8eacb477`, `614c8c16`, `40194f93`, `bb72d012`.

- `40194f93` closes two placeholder leak paths: missing resolver state now rejects
  reserved credential markers, and missing TLS-termination state returns a
  pre-200 CONNECT 503 rather than creating a raw tunnel. Upstream covers the 503
  with a loopback first-byte test and a full `handle_tcp_connection` test. Those
  tests do not reproduce the affected Docker 27 DGX Spark resolver/CA startup or
  complete a credential-bearing MCP lifecycle, so NemoClaw keeps its wire-level
  status probe and still requires the physical #6379 tool-call proof.
- `bb72d012` permits newline and carriage-return bytes in exec command arguments
  while retaining strict NUL and non-command-field validation. NemoClaw's active
  public guard and internal base64 workarounds must be removed or reclassified,
  and byte-exact LF, CRLF, quotes, and heredoc cases must pass without weakening
  workdir or environment validation.
- `8eacb477` changes the combined Docker supervisor even though its title names
  Kubernetes. The supervisor image changes from `scratch` plus one mode-0550
  binary to Alpine 3.22 with `nftables`, `iptables`, `iptables-legacy`, and a
  mode-0555 binary. The exact development result is Alpine 3.22.5 with 29 APK
  records, 152 mode-executable regular files, 391 symlinks, and no embedded
  license/notice path. This adds an OS package, SBOM, vulnerability, license, and
  executable surface that must be reviewed and bound to the final OCI digest.
  NemoClaw's Docker driver extracts only the binary, but still downloads the
  expanded, non-reproducibly resolved image.
- The same commit changes generic Docker namespace nft installation from an
  atomic batch to sequential commands. Required failures can occur after the
  policy-accept chain and accept rules exist but before all IPv4/IPv6 TCP/UDP
  rejects exist; the outer Docker setup records that failure as nonfatal. The
  exact required sequence is table creation, table flush, policy-accept output
  chain, proxy accept, loopback accept, IPv4 TCP reject, IPv6 TCP reject, IPv4 UDP
  reject, and IPv6 UDP reject; conntrack and log commands interspersed in that
  sequence are optional. `install_bypass_rules` stops at a required failure, while
  `create_netns_for_proxy` catches that error and returns the namespace as usable.
  Upstream tests inspect generated arguments and required flags but do not execute
  per-command failures. The final runtime proof must inspect the actual installed
  rules and verify direct bypass remains unavailable through restart and teardown;
  deterministic partial-failure injection remains an upstream testability gate.
- `10702133` makes each driver's default supervisor tag follow the gateway
  version. NemoClaw supplies an explicit image and supervisor binary, so the
  downstream invariant remains exact CLI/gateway/sandbox/component equality plus
  an immutable multi-architecture image digest.
- Shared child-process construction now strips `OPENSHELL_TLS_CA`,
  `OPENSHELL_TLS_CERT`, and `OPENSHELL_TLS_KEY` from entrypoint, exec, and connect
  children. Those values remain supervisor identity material; NemoClaw tests and
  comments must assert absence rather than describing child injection.
- Network binary identity now hashes the live `/proc/<pid>/exe` target. The
  cache remains keyed by the cleaned display path while its fingerprint and hash
  come from the live process inode. Upstream proves that an already-running Bash
  resolves to the old hash after unlink/replacement, but does not start the altered
  replacement and require its network request to fail. The migration must prove
  both halves in one live proxy session: the old process remains allowed and a new
  altered process at the same display path receives an exact policy denial.
- `ccdac9ce` adds sanitized MCP tool names to policy logs without logging
  arguments. Both the full JSON-RPC message and allowed MCP shorthand now include
  `rule_methods=tools/call tools=<name>`; `tool_names_for_log` reads only the
  parsed call name and replaces control characters. Upstream allow/deny tests
  assert that nested argument values are absent. This is an additive
  observability/privacy change and a repository-wide consumer search found no
  NemoClaw parser coupled to the old field order.
- Native Kubernetes sidecar/PVC/Helm changes, OpenShift documentation, and the TUI
  warning destination are not consumed by NemoClaw's Docker integration.

The newline migration was audited beyond the public `exec` guard. Production
gateway RPC now sends its reviewed module source directly, and the live E2E
clients pass trusted shell, Python, Node, heredoc, and positional-argument bytes
directly through OpenShell. The sweep removed newline-only base64/eval/temp-file
transports from endpoint smoke, network policy, MCP, messaging, pairing, rebuild,
recovery, plugin, inference-switch, and Deep Agents checks. Focused tests pin LF,
CRLF, heredoc, and positional-argument preservation at the raw OpenShell argv
boundary.

Remaining base64 use is independently classified: hostile or secret canaries are
kept inert; rendered file payloads and executable lifecycle fixtures are
deliberately materialized; gateway parameters remain data rather than code; and
oversized messaging-provider and scope-upgrade probes retain bounded chunks
because OpenShell still has a 32 KiB per-argument ceiling. The Hermes validator
wrapper remains the owned secret-boundary exception. None of those retained uses
exists merely to avoid a newline in an OpenShell command argument.

The exact-main MCP lane now has a separate credential-generation-window target
instead of adding repeated mutations to each 45-minute agent case. It holds one
OpenClaw child open on its original revision, performs a sequence of nine
distinct rotation updates (one more than OpenShell's eight retained generations),
proves that the evicted placeholder resolves only through the current key,
removes that key while the provider remains attached and proves the old
placeholder fails closed, then separately detaches the provider and proves both
fresh-child absence and old-child fail-closed behavior. A second retained child
proves its revision works before the provider's `--credential-expires-at`
deadline and is denied after that deadline while a newer current revision remains
usable. The target then reattaches through `mcp restart`, rebuilds without the
host MCP secret, and removes the bridge. Every request is identified independently
of its credential, and the upstream ledger is required to contain no literal
resolve placeholder.
The workflow runs this bounded target only against the exact reviewed development
artifacts and scans its artifacts for the whole generated-secret prefix. The
final stable-source review must retain the upstream
`expired_retained_generation_does_not_resolve` unit and rerun this live contract.

## Downstream concern ledger

| ID | Severity | Downstream consumer and failure mode | Required disposition | Current state |
|---|---|---|---|---|
| `OS82-01` | Critical | All stable selectors, archives, checksums, binaries, and the supervisor image could identify different builds. | Pin one published tag; verify producer run, signatures/attestations, release hashes, extracted binaries, component versions, OCI index and child manifests; reject archive traversal, links, devices, duplicates, or unexpected members. | Blocked: no stable `v0.0.82` release. |
| `OS82-02` | Critical | `mcp status` can be honest while the affected Spark still cannot initialize resolver/CA state or perform a credential-bearing request. | Physical Docker 27 DGX Spark: register credential, require status success, load tools, complete a real MCP tool call, and prove the literal placeholder never reaches upstream. | Blocked on assigned hardware proof. |
| `OS82-03` | High | `src/lib/actions/sandbox/exec.ts`, command dispatch, docs, and internal wrappers encode the old newline rejection. | Remove the obsolete public rejection and newline-only wrappers; prove byte-exact LF, CR, CRLF, quotes, and heredoc argv; retain NUL plus multiline workdir/environment rejection. | Source and internal-wrapper migration complete; candidate runtime proof open. |
| `OS82-04` | High | OpenShell child launch now clears the complete capability bounding set. Hosts without `CAP_SETPCAP` may fail if their runtime does not pre-clear it. | Prove entrypoint, exec, and connect launch with `CapBnd=0` on Linux Docker, DGX Spark arm64, macOS Docker Desktop/Colima, WSL, and Colossus; update NemoClaw's #3280 caveat only from runtime evidence. | Candidate exact-main proof now inspects the actual entrypoint, exec, and forced-TTY connect children for full `CapBnd=0`; exact-head Linux execution and every other platform remain open. |
| `OS82-05` | High | Versioned credential placeholders and the eight-generation window change long-running MCP behavior. | Regenerate the exact-version child-visible manifest; reject reserved `v<digits>_` names; test more than eight rotations, removed keys, detach, restart/rebuild, fresh exec revision, expiry, and literal-placeholder scans. | Exact-main generation-window proof implemented and workflow-mandatory; live execution, final manifest, and stable-source rerun remain open. |
| `OS82-06` | High | Initial policy acknowledgement and ordered retry can make the active gateway status lag enforcement. | Test initial LOADED/FAILED, hot update, retry outage/recovery, restart, exact version/hash re-read, and ordered drain. | Candidate exact-main proof now covers hot-update LOADED identity plus restart initial acknowledgement and exact version/hash recovery. Initial FAILED and isolated report outage/ordered drain remain an open runtime gate. |
| `OS82-07` | High | Sequential nft setup can leave an incomplete policy-accept ruleset after a required command fails; Docker setup treats the error as nonfatal. | Inject each required failure; inspect IPv4/IPv6 TCP/UDP rules and direct-bypass negatives on Linux x86 and Spark arm64; verify restart and teardown. | Candidate exact-main proof now inspects the live policy-accept chain and all four required rejects before/after restart, and probes controlled IPv4 TCP/UDP listeners. Required-command fault injection, routed IPv6 behavior, Spark arm64, and physical teardown remain an open security gate. |
| `OS82-08` | High | The supervisor image moves from one scratch binary to a 29-package Alpine filesystem resolved from a mutable base and unpinned APK names. NemoClaw's Docker path downloads it but executes only the extracted binary. | Retain exact per-arch package/version/license and file inventories; scan vulnerabilities; verify modes, multiarch manifests, base/package identities, source labels, OCI provenance, and extraction-only behavior; preserve an explicit digest. | Development identities and content are enumerated. Vulnerability results, license attribution, reproducible base/package inputs, attestation, and the final stable image remain open. |
| `OS82-09` | Medium-high | Normalized selected-driver config can change the effective Docker gateway even when the TOML text is unchanged. | Parse the final rendered TOML with the final binary; prove loopback/bridge listeners, JWT/mTLS, restart, persisted state, and legacy gateway upgrade. | Open runtime gate. |
| `OS82-10` | Medium-high | Supervisor TLS identity variables are no longer child environment. Stale tests/comments can normalize a credential leak. | Assert absence from entrypoint, exec, and connect children and update the source-of-truth rationale. | Hermes and Deep Agents now reject all three variables; the candidate exact-main entrypoint, exec, and connect probes require their absence, with exact-head execution pending. |
| `OS82-11` | Medium-high | Live `/proc/<pid>/exe` identity changes replacement-time policy behavior. | Prove old process survives replacement and a new altered process at the same path is denied. | Candidate exact-main proof runs both processes against the real proxy and requires old=200 before/after replacement, distinct live/path hashes, and new=403; exact-head runtime result pending. |
| `OS82-12` | Medium | OpenShell declares Docker 28.0+ while #6379 is on Docker 27 and NemoClaw marks DGX Spark tested. | Either validate and document a precise downstream exception from physical proof or raise the supported floor and preflight it. | Open product/platform decision. |
| `OS82-13` | Low | Mount parsing/SELinux changes could affect the test-only tmpfs path. | Rerun the EXDEV tmpfs fixture and retain production no-mount evidence. | Open targeted test. |
| `OS82-14` | Low | Sanitized MCP tool names are newly present in logs. | Record the additive observability/privacy behavior; ensure no downstream parser assumes the old shape. | Candidate exact-main check requires the real `fake_echo` tool name and rejects argument/result canaries or an `arguments` field in JSON-RPC policy logs; exact-head runtime result pending. |
| `OS82-15` | High | The installer-hash workflow executes its checker and parser from the PR base SHA. One PR cannot safely teach that trusted base about a new release and consume the release; using the head checker would let reviewed code define its own trust rules. | First land archive safety, normalized full-script template validation, and multi-release trust while selectors remain `0.0.72`; prove the old base rejects a new release and the new base permits only structured release-data changes; then submit the `0.0.82` pin. | NemoClaw-only prerequisite implementation in progress. |
| `OS82-16` | High | Capability clearing now depends on `capctl 0.2.4` and `bitflags 1.3.2`, but upstream notices are unchanged and the consumed binaries have no published SBOM or attestation covering this dependency graph. | Bind crate checksums and source identities to the stable lock and binaries; review the unsafe syscall boundary and advisories; update notices/licenses; retain a generated SBOM and provenance for every consumed binary. | Candidate crate source, checksums, licenses, unsafe boundary, and current RustSec absence are recorded. Stable lock-to-binary SBOM, notices, and provenance remain open. |
| `OS82-17` | Medium | The VM driver bakes configurable UID/GID into prepared rootfs state, but its same-version cache key omits both values and can reuse stale passwd/group entries after configuration drift. | Keep NemoClaw's selected driver Docker-only. Before any VM path is supported, key prepared images by UID/GID or purge them and prove identity/ownership after change and restart. | Source-reviewed exclusion for the current Docker topology; VM configuration-churn compatibility is unproven. |

An unresolved critical or high concern blocks the version selector change. A green
aggregate test suite does not override an open ledger row.

## Exact-main policy, nft, identity, and log proof boundary

The moving-main Deep Agents job now invokes
`openshell-exact-main-runtime-contracts.ts` only when
`NEMOCLAW_OPENSHELL_EXACT_MAIN_PROOF=1`. The proof runs before MCP registration,
uses a temporary base-policy extension, and restores the exact captured base
policy before the managed MCP lifecycle continues. It performs these concrete
checks against the reviewed CLI, gateway, supervisor image, and sandbox binary:

1. Apply a hot policy revision with `--wait`, then independently require the
   effective and stored-revision JSON to agree on sandbox, version, active
   version, hash, and LOADED/effective state.
2. Read `nft -j` inside the real `sandbox-*` network namespace. Require the
   dangerous policy-accept output chain, proxy and loopback accepts before the
   rejects, and exactly one IPv4/IPv6 TCP/UDP port-unreachable reject each.
3. Restart the actual OpenShell-managed Docker container. Require the same exact
   policy revision/hash, the initial-revision acknowledgement log for that
   version, and the complete nft ruleset again.
4. Bind controlled TCP and UDP echo listeners to the supervisor-side
   `10.200.0.1` veth, then require workload direct connections to fail quickly
   with `ECONNREFUSED`. This distinguishes nft rejection from an unreachable or
   unbound external address.
5. Allow a copied Bash at one exact path to open the real proxy, replace the
   path with a different executable inode, and require the old process to remain
   allowed before and after replacement while the new altered process at the
   same path receives HTTP 403. The evidence records different
   `/proc/<old-pid>/exe` and replacement-path hashes.
6. After the authenticated real MCP call, read sandbox policy logs and require
   `decision=allow rule_methods=tools/call tools=fake_echo`. Argument and result
   canaries, plus any `arguments` field, are forbidden from those JSON-RPC lines.

This boundary deliberately does not fake fault injection. OpenShell exposes no
hook that fails only `report_policy_status` while allowing policy polling and
mutation to continue; stopping the gateway would conflate the reporting outage
with loss of the source being polled. It likewise exposes no downstream control
between individual required nft commands. Editing the installed table after
startup would prove that NemoClaw can damage nft state, not that OpenShell handles
a real command failure. The smallest honest missing proofs are upstream-injected
report transport/construction failures and an nft executor that can fail each
required command, followed by the physical Spark run. The Docker namespace has no
routed non-loopback IPv6 address, so the candidate asserts the installed IPv6
rejects structurally; routed IPv6 bypass behavior belongs in a platform fixture
that actually configures IPv6. No OpenShell repository mutation is part of this
NemoClaw work.

## Test-selection and false-green audit

The moving-development MCP workflow currently classifies an OpenShell version
different from the versioned child-visible credential manifest as an expected
compatibility rejection, records the classification as passed, and does not run
the full managed MCP lifecycle. That is correct fail-closed behavior for an
unreviewed development runtime, but it is not evidence that the candidate is
compatible.

Before any `0.0.82` selector can be called green, the credential manifest and all
of its imports/image copies must identify the reviewed candidate, the workflow
must select `full-lifecycle`, and all three agents must complete registration,
credential rotation, DNS-rebinding denial, policy denial, real tool invocation,
restart/rebuild, and cleanup without a conditional skip or expected failure.

## Final acceptance gates

1. The trusted installer/hash prerequisite lands on NemoClaw `main` while all
   runtime selectors remain `0.0.72`. Its base-owned parser rejects operational
   installer drift and permits only validated release-data and selector changes.
2. A stable OpenShell tag contains `bb72d012` or a reviewed descendant. Re-run
   this entire adjacent-source audit for every commit between `bb72d012` and that
   tag.
3. The tag has a successful release publication. Every consumed archive and OCI
   child manifest is bound to that producer run and source identity. Stable
   binary and image SBOMs, notices, licenses, advisory results, and provenance
   account for the exact Rust and APK graphs above.
4. Blueprint bounds, installer tables, Brev defaults, workflow pins, feature-gate
   hashes, supervisor digest, credential manifest, tests, and active docs select
   one coherent version.
5. Every concern-specific unit/integration proof above passes, followed by normal
   repository checks and exact-head CI/advisor review.
6. The non-skipped live matrix passes on Linux x86 Docker, macOS Docker
   Desktop/Colima, WSL, Colossus, and physical DGX Spark arm64. Legacy gateway
   upgrade, restart, rollback, and teardown remain explicit phases.
7. The physical #6379 Spark run completes an authenticated real MCP tool call and
   reports any failure honestly. Inclusion of `40194f93` alone cannot close the
   issue.
