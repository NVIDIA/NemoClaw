#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if (($# != 4)); then
  printf 'Usage: %s OUTPUT_DIR PERL_VERSION PERL_SHA256 PACKAGE_REVISION\n' "$0" >&2
  exit 64
fi

readonly output_dir="$1"
readonly perl_version="$2"
readonly perl_sha256="$3"
readonly package_revision="$4"
build_root="$(mktemp -d /tmp/nemoclaw-perl-security.XXXXXX)"
readonly build_root
readonly source_archive="${build_root}/perl.tar.xz"
readonly source_dir="${build_root}/perl-source"
readonly perl_root="${build_root}/perl-root"
readonly perl_meta="${build_root}/perl-meta"

cleanup() {
  rm -rf "${build_root}"
}
trap cleanup EXIT

mkdir -p "${output_dir}" "${source_dir}"

curl --proto '=https' --tlsv1.2 -fsSL \
  --retry 5 --retry-all-errors --retry-delay 2 \
  --connect-timeout 15 --max-time 120 \
  -o "${source_archive}" \
  "https://www.cpan.org/src/5.0/perl-${perl_version}.tar.xz"
printf '%s  %s\n' "${perl_sha256}" "${source_archive}" >"${build_root}/perl.sha256"
sha256sum -c "${build_root}/perl.sha256"
tar -xJf "${source_archive}" -C "${source_dir}" --strip-components=1

(
  cd "${source_dir}"
  # Pin the reviewed d_syscallproto result for trixie's libc so both native
  # architectures use the same known declaration instead of relying on a
  # Configure probe that previously returned a false negative under QEMU.
  # Remove this override only after the pinned base image and Perl release report
  # d_syscallproto=define from native Configure probes on amd64 and arm64.
  ./Configure -des \
    -Dprefix=/usr \
    -Dvendorprefix=/usr \
    -Dsiteprefix=/usr/local \
    -Dusethreads \
    -Duse64bitall \
    -Dd_syscallproto=define \
    -Dman1dir=none \
    -Dman3dir=none
  make -j"$(nproc)"
  make test_prep
  # ExtUtils::Constant's test recursively invokes make and produced an incomplete
  # TAP plan when it overlapped another test locally, so run it alone first and
  # exclude exactly that already-passed file from the parallel pass.
  # Remove this split only after the unsplit parallel harness passes in two
  # consecutive amd64 and arm64 base-image builds; keep the selection-equivalence
  # check below until that removal condition is met.
  env -C t PERL_TEST_HARNESS_ASAP=1 ./perl harness -dumptests \
    >"${build_root}/perl-tests-full"
  env -C t ./perl harness -dumptests \
    ../cpan/ExtUtils-Constant/t/Constant.t \
    >"${build_root}/perl-tests-serial"
  env -C t PERL_TEST_HARNESS_ASAP=1 ./perl harness -dumptests \
    '--nre=^[.][.]/cpan/ExtUtils-Constant/t/Constant[.]t$' \
    >"${build_root}/perl-tests-parallel"
  sort "${build_root}/perl-tests-full" \
    >"${build_root}/perl-tests-full.sorted"
  sort \
    "${build_root}/perl-tests-serial" \
    "${build_root}/perl-tests-parallel" \
    >"${build_root}/perl-tests-combined.sorted"
  cmp \
    "${build_root}/perl-tests-full.sorted" \
    "${build_root}/perl-tests-combined.sorted"
  # harness -dumptests reports paths from the source root and removes ../.
  test "$(
    grep -Fxc \
      'cpan/ExtUtils-Constant/t/Constant.t' \
      "${build_root}/perl-tests-combined.sorted"
  )" -eq 1
  # Perl's test_harness runs the same upstream suite while TEST_JOBS lets its TAP
  # scheduler use each native runner efficiently instead of serializing every
  # script in QEMU.
  TEST_JOBS=1 \
    TEST_ARGS='../cpan/ExtUtils-Constant/t/Constant.t' \
    make test_harness
  TEST_JOBS="$(nproc)" \
  PERL_TEST_HARNESS_ASAP=1 \
  TEST_ARGS='--nre=^[.][.]/cpan/ExtUtils-Constant/t/Constant[.]t$' \
    make -j"$(nproc)" test_harness
  make install DESTDIR="${perl_root}"
)

package_version="${perl_version}-${package_revision}"
readonly package_version
architecture="$(dpkg --print-architecture)"
readonly architecture
mkdir -p "${perl_root}/DEBIAN" "${perl_meta}/DEBIAN"
printf '%s\n' \
  'Package: perl-base' \
  "Version: ${package_version}" \
  "Architecture: ${architecture}" \
  'Essential: yes' \
  'Priority: required' \
  'Section: perl' \
  'Multi-Arch: allowed' \
  'Maintainer: NVIDIA NemoClaw Maintainers' \
  "Provides: libperl5.40 (= ${package_version}), perl-modules-5.40 (= ${package_version})" \
  'Conflicts: libperl5.40, perl-modules-5.40' \
  "Breaks: perl (<< ${package_version})" \
  "Replaces: libperl5.40, perl-modules-5.40, perl (<< ${package_version})" \
  'Description: Perl 5 language interpreter built for the NemoClaw sandbox' \
  >"${perl_root}/DEBIAN/control"
printf '%s\n' \
  'Package: perl' \
  "Version: ${package_version}" \
  "Architecture: ${architecture}" \
  'Priority: standard' \
  'Section: perl' \
  'Multi-Arch: allowed' \
  "Depends: perl-base (= ${package_version})" \
  'Maintainer: NVIDIA NemoClaw Maintainers' \
  'Description: Perl 5 language interpreter metapackage for the NemoClaw sandbox' \
  >"${perl_meta}/DEBIAN/control"
dpkg-deb --build --root-owner-group \
  "${perl_root}" "${output_dir}/perl-base.deb"
dpkg-deb --build --root-owner-group \
  "${perl_meta}" "${output_dir}/perl.deb"
test "$(dpkg-deb -f "${output_dir}/perl-base.deb" Version)" = "${package_version}"
test "$(dpkg-deb -f "${output_dir}/perl.deb" Version)" = "${package_version}"
