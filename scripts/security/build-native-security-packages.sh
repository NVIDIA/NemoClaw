#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

readonly LIBSSH2_VERSION="1.11.1"
readonly LIBSSH2_DEBIAN_VERSION="1.11.1-1+deb13u1"
readonly LIBSSH2_PACKAGE_VERSION="${LIBSSH2_DEBIAN_VERSION}+nemoclaw1"
readonly LIBSSH2_SOURCE_SHA256="9954cb54c4f548198a7cbebad248bdc87dd64bd26185708a294b2b50771e3769"
readonly PYTHON_DEBIAN_VERSION="3.13.5-2+deb13u4"
readonly PYTHON_FIX_VERSION="${PYTHON_DEBIAN_VERSION}+nemoclaw1"
readonly PYTHON_PARSER_SHA256="f91ec3de6331206bbe2ec3e54a05f646bd23d3c61a18d4a01b25164e070bacc9"
readonly PYTHON_PARSER_FIXED_SHA256="4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7"
readonly DEBIAN_SNAPSHOT_URL="https://snapshot.debian.org/archive/debian/20260724T000000Z/pool/main"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_dir
readonly patch_dir="${script_dir}/patches"
readonly output_dir="${1:-/out}"
build_root="$(mktemp -d /tmp/nemoclaw-native-security.XXXXXX)"
readonly build_root

cleanup() {
  rm -rf "${build_root}"
}
trap cleanup EXIT

download() {
  local url="$1"
  local output="$2"
  curl --proto '=https' --tlsv1.2 -fsSL \
    --retry 5 --retry-all-errors --retry-delay 2 \
    --connect-timeout 15 --max-time 120 \
    -o "${output}" "${url}"
}

verify_sha256() {
  local expected="$1"
  local path="$2"
  printf '%s  %s\n' "${expected}" "${path}" | sha256sum -c -
}

rewrite_control_field() {
  local control="$1"
  local field="$2"
  local value="$3"
  sed -i "s/^${field}: .*$/${field}: ${value}/" "${control}"
  grep -Fqx "${field}: ${value}" "${control}"
}

refresh_md5sums() {
  local package_root="$1"
  (
    cd "${package_root}"
    find . -path ./DEBIAN -prune -o -type f -printf '%P\0' \
      | sort -z \
      | xargs -0 md5sum
  ) >"${package_root}/DEBIAN/md5sums"
}

read_make_list() {
  local makefile="$1"
  local variable="$2"

  awk -v variable="${variable}" '
    $0 ~ "^" variable "[[:space:]]*=" {
      capture = 1
      sub("^[^=]*=[[:space:]]*", "")
    }
    capture {
      continued = sub(/[[:space:]]*\\[[:space:]]*$/, "")
      for (field = 1; field <= NF; field++) {
        print "./" $field
      }
      if (!continued) {
        exit
      }
    }
  ' "${makefile}"
}

run_libssh2_tests() {
  local source_dir="$1"
  local test_output
  local test_user="libssh2"
  local -a docker_tests
  local -a sshd_tests
  local -a full_tests

  mapfile -t docker_tests < <(
    read_make_list "${source_dir}/tests/Makefile.inc" DOCKER_TESTS
  )
  mapfile -t sshd_tests < <(
    read_make_list "${source_dir}/tests/Makefile.inc" SSHD_TESTS
  )
  test "${#docker_tests[@]}" -eq 22
  test "${#sshd_tests[@]}" -eq 2
  test "$(wc -l <"${source_dir}/tests/test_read_algos.txt")" -eq 18
  full_tests=(
    "${docker_tests[@]}"
    "${sshd_tests[@]}"
    ./test_read_algos.test
  )

  # sshd reads AuthorizedKeysFile after dropping privileges to the fixture
  # user, so the mktemp parent must be traversable during the test run.
  chmod o+x "$(dirname -- "${source_dir}")"
  if ! id "${test_user}" >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash "${test_user}"
  fi
  printf '%s\n' "${test_user}:my test password" | chpasswd
  install -d -o "${test_user}" -g "${test_user}" \
    "/home/${test_user}/.ssh" \
    "/home/${test_user}/sandbox"
  install -o "${test_user}" -g "${test_user}" -m 0600 \
    "${source_dir}/tests/openssh_server/authorized_keys" \
    "/home/${test_user}/.ssh/authorized_keys"
  sed -i \
    's/session[[:space:]]*required[[:space:]]*pam_loginuid.so/session optional pam_loginuid.so/' \
    /etc/pam.d/sshd

  (
    cd "${source_dir}"
    make check
  )

  if ! test_output="$(
    cd "${source_dir}/tests"
    USER="${test_user}" \
      LOGNAME="${test_user}" \
      SSHD_FLAGS="-o UsePAM=yes -o KbdInteractiveAuthentication=yes -o PasswordAuthentication=yes -o PerSourcePenalties=no" \
      ./test_sshd.test "${full_tests[@]}" 2>&1
  )"; then
    printf '%s\n' "${test_output}" >&2
    return 1
  fi
  printf '%s\n' "${test_output}"
  if grep -Eq '^not ok([[:space:]]|$)' <<<"${test_output}"; then
    printf 'A nested libssh2 TAP test reported a failure.\n' >&2
    return 1
  fi
}

build_libssh2_package() {
  local architecture="$1"
  local original_sha256
  local original_deb="${build_root}/libssh2-original.deb"
  local source_archive="${build_root}/libssh2.tar.xz"
  local source_dir="${build_root}/libssh2-source"
  local install_root="${build_root}/libssh2-install"
  local package_root="${build_root}/libssh2-package"
  local multiarch

  case "${architecture}" in
    amd64)
      original_sha256="915c4ec450a369d430e0151f9e10e25044ea2f0d6e41901e00a9317e232e5683"
      ;;
    arm64)
      original_sha256="600c2a845d6d14d292c765382bc7e644898762e1634a4aecf5b85329622dbbfe"
      ;;
    *)
      printf 'Unsupported architecture: %s\n' "${architecture}" >&2
      return 64
      ;;
  esac

  download \
    "https://libssh2.org/download/libssh2-${LIBSSH2_VERSION}.tar.xz" \
    "${source_archive}"
  verify_sha256 "${LIBSSH2_SOURCE_SHA256}" "${source_archive}"
  mkdir -p "${source_dir}"
  tar -xJf "${source_archive}" -C "${source_dir}" --strip-components=1
  git -C "${source_dir}" apply --check \
    "${patch_dir}/libssh2-1.11.1-cve-2026.patch"
  git -C "${source_dir}" apply \
    "${patch_dir}/libssh2-1.11.1-cve-2026.patch"

  (
    cd "${source_dir}"
    ./configure \
      --prefix=/usr \
      --disable-static \
      --disable-docker-tests \
      --disable-sshd-tests \
      --with-crypto=openssl \
      --with-libz
    make -j"$(nproc)"
    run_libssh2_tests "${source_dir}"
    make DESTDIR="${install_root}" install
  )

  multiarch="$(gcc -print-multiarch)"
  test -n "${multiarch}"
  test -f "${install_root}/usr/lib/libssh2.so.1.0.1"

  download \
    "${DEBIAN_SNAPSHOT_URL}/libs/libssh2/libssh2-1t64_${LIBSSH2_DEBIAN_VERSION}_${architecture}.deb" \
    "${original_deb}"
  verify_sha256 "${original_sha256}" "${original_deb}"
  dpkg-deb -R "${original_deb}" "${package_root}"
  test "$(dpkg-deb -f "${original_deb}" Package)" = "libssh2-1t64"
  test "$(dpkg-deb -f "${original_deb}" Version)" = "${LIBSSH2_DEBIAN_VERSION}"

  local original_library="${package_root}/usr/lib/${multiarch}/libssh2.so.1.0.1"
  local fixed_library="${install_root}/usr/lib/libssh2.so.1.0.1"
  test -f "${original_library}"
  readelf -d "${fixed_library}" | grep -Fq '(SONAME)' \
    && readelf -d "${fixed_library}" | grep -Fq '[libssh2.so.1]'
  nm -D --defined-only --format=posix "${original_library}" \
    | cut -d ' ' -f 1 | sort -u >"${build_root}/libssh2-original.symbols"
  nm -D --defined-only --format=posix "${fixed_library}" \
    | cut -d ' ' -f 1 | sort -u >"${build_root}/libssh2-fixed.symbols"
  comm -23 \
    "${build_root}/libssh2-original.symbols" \
    "${build_root}/libssh2-fixed.symbols" \
    >"${build_root}/libssh2-missing.symbols"
  test ! -s "${build_root}/libssh2-missing.symbols"

  install -m 0644 "${fixed_library}" "${original_library}"
  rewrite_control_field \
    "${package_root}/DEBIAN/control" Version "${LIBSSH2_PACKAGE_VERSION}"
  rewrite_control_field \
    "${package_root}/DEBIAN/control" Provides \
    "libssh2-1 (= ${LIBSSH2_PACKAGE_VERSION})"
  rewrite_control_field \
    "${package_root}/DEBIAN/control" Breaks \
    "libssh2-1 (<< ${LIBSSH2_PACKAGE_VERSION})"
  refresh_md5sums "${package_root}"
  dpkg-deb --build --root-owner-group \
    "${package_root}" \
    "${output_dir}/libssh2-1t64.deb"
  test "$(dpkg-deb -f "${output_dir}/libssh2-1t64.deb" Version)" = \
    "${LIBSSH2_PACKAGE_VERSION}"
}

build_python_fix_package() {
  local architecture="$1"
  local original_sha256
  local original_deb="${build_root}/python-stdlib-original.deb"
  local original_root="${build_root}/python-stdlib-original"
  local package_root="${build_root}/python-htmlparser-fix"
  local parser_path="usr/lib/python3.13/html/parser.py"

  case "${architecture}" in
    amd64)
      original_sha256="0def2d972310b59704ad119abee5a97f95409e14ff1359edd8cc7b8892cfd43f"
      ;;
    arm64)
      original_sha256="37cce6086b7c1ca93086f83b68761737607689e634693b6972b5dbfd6c080872"
      ;;
    *)
      printf 'Unsupported architecture: %s\n' "${architecture}" >&2
      return 64
      ;;
  esac

  download \
    "${DEBIAN_SNAPSHOT_URL}/p/python3.13/libpython3.13-stdlib_${PYTHON_DEBIAN_VERSION}_${architecture}.deb" \
    "${original_deb}"
  verify_sha256 "${original_sha256}" "${original_deb}"
  dpkg-deb -x "${original_deb}" "${original_root}"
  test "$(dpkg-deb -f "${original_deb}" Package)" = "libpython3.13-stdlib"
  test "$(dpkg-deb -f "${original_deb}" Version)" = "${PYTHON_DEBIAN_VERSION}"
  verify_sha256 "${PYTHON_PARSER_SHA256}" "${original_root}/${parser_path}"

  mkdir -p "${package_root}/DEBIAN" \
    "$(dirname -- "${package_root}/${parser_path}")"
  install -m 0644 \
    "${original_root}/${parser_path}" \
    "${package_root}/${parser_path}"
  git -C "${package_root}" apply --check \
    "${patch_dir}/python3.13-htmlparser-cve-2026-15308.patch"
  git -C "${package_root}" apply \
    "${patch_dir}/python3.13-htmlparser-cve-2026-15308.patch"
  verify_sha256 \
    "${PYTHON_PARSER_FIXED_SHA256}" \
    "${package_root}/${parser_path}"

  printf '%s\n' \
    'Package: nemoclaw-python3.13-htmlparser-fix' \
    "Version: ${PYTHON_FIX_VERSION}" \
    'Architecture: all' \
    'Priority: optional' \
    'Section: python' \
    "Depends: libpython3.13-stdlib (= ${PYTHON_DEBIAN_VERSION})" \
    "Replaces: libpython3.13-stdlib (<= ${PYTHON_DEBIAN_VERSION})" \
    'Maintainer: NVIDIA NemoClaw Maintainers' \
    'Description: NemoClaw HTMLParser security backport for Python 3.13' \
    ' Backports the upstream fix for incremental parsing complexity.' \
    >"${package_root}/DEBIAN/control"
  refresh_md5sums "${package_root}"
  dpkg-deb --build --root-owner-group \
    "${package_root}" \
    "${output_dir}/nemoclaw-python3.13-htmlparser-fix.deb"
  test "$(dpkg-deb -f "${output_dir}/nemoclaw-python3.13-htmlparser-fix.deb" Version)" = \
    "${PYTHON_FIX_VERSION}"
}

main() {
  local architecture

  mkdir -p "${output_dir}"
  architecture="$(dpkg --print-architecture)"
  build_libssh2_package "${architecture}"
  build_python_fix_package "${architecture}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main
fi
