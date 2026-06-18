#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

DRIVER_BRANCH="${NVIDIA_DRIVER_BRANCH:-580}"
DRIVER_PACKAGE_DEBIAN="${NVIDIA_DRIVER_PACKAGE_DEBIAN:-nvidia-open-${DRIVER_BRANCH}}"
DRIVER_PACKAGE_RHEL="${NVIDIA_DRIVER_PACKAGE_RHEL:-nvidia-driver-cuda}"
DRIVER_KMOD_RHEL="${NVIDIA_DRIVER_KMOD_RHEL:-kmod-nvidia-open-dkms}"
DRIVER_PACKAGE_SUSE="${NVIDIA_DRIVER_PACKAGE_SUSE:-nvidia-open-driver-G06-signed-kmp-default}"
CUDA_PACKAGE="${NVIDIA_CUDA_PACKAGE:-cuda-toolkit-13-0}"
CUDA_PATH="${NVIDIA_CUDA_PATH:-/usr/local/cuda-13.0}"
CONTAINER_TOOLKIT_VERSION="${NVIDIA_CONTAINER_TOOLKIT_VERSION:-1.19.0-1}"
CONTAINER_TOOLKIT_VERSION_BARE="${CONTAINER_TOOLKIT_VERSION%-*}"  # "1.19.0-1" -> "1.19.0"
DOCKER_PACKAGE_DEBIAN="${DOCKER_PACKAGE_DEBIAN:-${DOCKER_PACKAGE:-docker.io}}"
BACKEND="docker"
INSTALL=0
YES=0
CONFIGURE_DOCKER=1
INSTALL_DOCKER=1
ADD_USER_TO_DOCKER_GROUP=1

PKG_FAMILY=""        # debian | rhel | suse | arch | unknown
PKG_MANAGER=""       # apt-get | dnf | yum | zypper | pacman
DISTRO_ID=""         # ubuntu | debian | fedora | rhel | rocky | almalinux | opensuse-leap | sles | arch | ...
DISTRO_VERSION_ID="" # e.g. "22.04", "9", "41"
DISTRO_PRETTY=""
CUDA_REPO_DISTRO=""  # e.g. ubuntu2204, debian12, rhel9, fedora41, sles15
CUDA_REPO_ARCH=""    # x86_64 | sbsa

usage() {
  cat <<'USAGE'
Usage: setup-nvidia-gpu-host.sh [--backend docker|kubernetes] [--check-only|--install] [--yes]
                                [--skip-docker-install] [--skip-docker-config] [--skip-docker-group]

Checks and (with --install) installs the TAO GPU host runtime:
  - NVIDIA driver branch 580 (open kernel module preferred)
  - CUDA Toolkit 13.0
  - NVIDIA Container Toolkit 1.19.0-1
  - Docker engine (installed on demand for the docker / local-docker backend)

By default this script only checks. The --check-only path runs on any Linux
distribution because it only queries `nvidia-smi`, the CUDA toolkit path, the
installed container-toolkit package version, and (for Docker backends) the
Docker daemon's NVIDIA runtime.

The --install path automates installation for the following families:
  - debian-family (Ubuntu 22.04/24.04, Debian 12)        — apt + docker.io
  - rhel-family   (Fedora, RHEL/Rocky/AlmaLinux 9 / 10)  — dnf + docker-ce
                                                          (falls back to
                                                          moby-engine on
                                                          Fedora)
  - suse-family   (openSUSE Leap, SLES 15)               — zypper + docker

Other distributions (Arch, Alpine, Gentoo, …) fall through to a clear error
that lists the version targets and the NVIDIA documentation URL — install
manually, then rerun with --check-only.

Override the driver package family choices with the env vars
$NVIDIA_DRIVER_PACKAGE_DEBIAN, $NVIDIA_DRIVER_PACKAGE_RHEL,
$NVIDIA_DRIVER_KMOD_RHEL, $NVIDIA_DRIVER_PACKAGE_SUSE if your distro uses
different names. Override the Docker package with $DOCKER_PACKAGE_DEBIAN
(legacy: $DOCKER_PACKAGE) on debian-family hosts.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)
      BACKEND="${2:-}"
      shift 2
      ;;
    --check-only)
      INSTALL=0
      shift
      ;;
    --install)
      INSTALL=1
      shift
      ;;
    -y|--yes)
      YES=1
      shift
      ;;
    --skip-docker-config)
      CONFIGURE_DOCKER=0
      shift
      ;;
    --skip-docker-install)
      INSTALL_DOCKER=0
      shift
      ;;
    --skip-docker-group)
      ADD_USER_TO_DOCKER_GROUP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$BACKEND" in
  docker|local-docker|kubernetes|k8s) ;;
  *)
    echo "Unsupported backend: $BACKEND" >&2
    exit 2
    ;;
esac

SUDO=()
if [[ "${EUID}" -ne 0 ]]; then
  SUDO=(sudo)
fi

have() {
  command -v "$1" >/dev/null 2>&1
}

sudo_available() {
  [[ "${EUID}" -eq 0 ]] || sudo -n true >/dev/null 2>&1
}

detect_distro() {
  if [[ ! -r /etc/os-release ]]; then
    PKG_FAMILY="unknown"
    return 0
  fi
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_VERSION_ID="${VERSION_ID:-}"
  DISTRO_PRETTY="${PRETTY_NAME:-${DISTRO_ID} ${DISTRO_VERSION_ID}}"
  local id_like="${ID_LIKE:-}"

  case "$DISTRO_ID" in
    ubuntu|debian|linuxmint|pop|raspbian)
      PKG_FAMILY=debian
      PKG_MANAGER=apt-get
      ;;
    fedora)
      PKG_FAMILY=rhel
      PKG_MANAGER=dnf
      ;;
    rhel|rocky|almalinux|centos|ol|amzn)
      PKG_FAMILY=rhel
      if have dnf; then PKG_MANAGER=dnf; else PKG_MANAGER=yum; fi
      ;;
    opensuse-leap|opensuse-tumbleweed|sles|sled)
      PKG_FAMILY=suse
      PKG_MANAGER=zypper
      ;;
    arch|manjaro|endeavouros|cachyos|garuda)
      PKG_FAMILY=arch
      PKG_MANAGER=pacman
      ;;
    *)
      case " $id_like " in
        *" debian "*|*" ubuntu "*)
          PKG_FAMILY=debian; PKG_MANAGER=apt-get ;;
        *" rhel "*|*" fedora "*|*" centos "*)
          PKG_FAMILY=rhel
          if have dnf; then PKG_MANAGER=dnf; else PKG_MANAGER=yum; fi
          ;;
        *" suse "*|*" opensuse "*)
          PKG_FAMILY=suse; PKG_MANAGER=zypper ;;
        *" arch "*)
          PKG_FAMILY=arch; PKG_MANAGER=pacman ;;
        *)
          PKG_FAMILY=unknown; PKG_MANAGER="" ;;
      esac
      ;;
  esac

  case "$DISTRO_ID" in
    ubuntu)
      # 22.04 -> ubuntu2204, 24.04 -> ubuntu2404
      CUDA_REPO_DISTRO="ubuntu${DISTRO_VERSION_ID//./}"
      ;;
    debian)
      CUDA_REPO_DISTRO="debian${DISTRO_VERSION_ID%%.*}"
      ;;
    fedora)
      CUDA_REPO_DISTRO="fedora${DISTRO_VERSION_ID%%.*}"
      ;;
    rhel|rocky|almalinux|centos|ol)
      CUDA_REPO_DISTRO="rhel${DISTRO_VERSION_ID%%.*}"
      ;;
    opensuse-leap)
      CUDA_REPO_DISTRO="opensuse${DISTRO_VERSION_ID%%.*}"
      ;;
    sles|sled)
      CUDA_REPO_DISTRO="sles${DISTRO_VERSION_ID%%.*}"
      ;;
    *)
      CUDA_REPO_DISTRO=""
      ;;
  esac

  # Debian-family derivatives (Pop!_OS, Mint, elementary, KDE Neon, Zorin,
  # Raspbian, …) do not have their own NVIDIA CUDA repo. Map them onto the
  # closest upstream Ubuntu/Debian repo via UBUNTU_CODENAME / VERSION_CODENAME.
  if [[ -z "$CUDA_REPO_DISTRO" && "$PKG_FAMILY" == "debian" ]]; then
    local codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
    case "$codename" in
      focal)    CUDA_REPO_DISTRO="ubuntu2004" ;;
      jammy)    CUDA_REPO_DISTRO="ubuntu2204" ;;
      noble)    CUDA_REPO_DISTRO="ubuntu2404" ;;
      bullseye) CUDA_REPO_DISTRO="debian11" ;;
      bookworm) CUDA_REPO_DISTRO="debian12" ;;
      trixie)   CUDA_REPO_DISTRO="debian12" ;;  # newest Debian, closest upstream repo
    esac
  fi

  case "$(uname -m)" in
    x86_64|amd64) CUDA_REPO_ARCH=x86_64 ;;
    aarch64|arm64) CUDA_REPO_ARCH=sbsa ;;
    *) CUDA_REPO_ARCH="" ;;
  esac
}

driver_ok() {
  have nvidia-smi || return 1
  local version
  version="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  [[ "$version" == "${DRIVER_BRANCH}".* ]]
}

cuda_ok() {
  [[ -x "${CUDA_PATH}/bin/nvcc" ]] || return 1
  "${CUDA_PATH}/bin/nvcc" --version 2>/dev/null | grep -q 'release 13\.0'
}

container_toolkit_ok() {
  # Probe in order of specificity: dpkg (debian), rpm (rhel/suse), nvidia-ctk
  # binary version (universal fallback for distros where the package metadata
  # is not in a standard tool).
  local installed=""
  if have dpkg-query; then
    installed="$(dpkg-query -W -f='${Version}' nvidia-container-toolkit 2>/dev/null || true)"
    if [[ -n "$installed" ]]; then
      [[ "$installed" == "$CONTAINER_TOOLKIT_VERSION" \
        || "$installed" == "${CONTAINER_TOOLKIT_VERSION_BARE}"* ]]
      return $?
    fi
  fi
  if have rpm; then
    installed="$(rpm -q --queryformat '%{VERSION}' nvidia-container-toolkit 2>/dev/null \
                 | grep -v '^package ' || true)"
    if [[ -n "$installed" ]]; then
      [[ "$installed" == "$CONTAINER_TOOLKIT_VERSION_BARE" ]]
      return $?
    fi
  fi
  if have nvidia-ctk; then
    installed="$(nvidia-ctk --version 2>/dev/null | head -n1 \
                 | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
    if [[ -n "$installed" ]]; then
      [[ "$installed" == "$CONTAINER_TOOLKIT_VERSION_BARE" ]]
      return $?
    fi
  fi
  return 1
}

docker_installed_ok() {
  have docker
}

docker_runtime_ok() {
  docker_installed_ok || return 1
  if docker info >/dev/null 2>&1; then
    docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'
    return $?
  fi
  if sudo_available; then
    sudo docker info >/dev/null 2>&1 || return 1
    sudo docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"'
    return $?
  fi
  return 1
}

kubernetes_gpu_ok() {
  have kubectl || return 2
  local gpu
  gpu="$(kubectl get nodes -o jsonpath='{range .items[*]}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}' 2>/dev/null | grep -v '^$' | head -n 1 || true)"
  [[ -n "$gpu" && "$gpu" != "0" ]]
}

print_status() {
  if driver_ok; then
    echo "OK: NVIDIA driver branch ${DRIVER_BRANCH}"
  else
    echo "MISSING: NVIDIA driver branch ${DRIVER_BRANCH}"
  fi

  if cuda_ok; then
    echo "OK: CUDA Toolkit 13.0 at ${CUDA_PATH}"
  else
    echo "MISSING: CUDA Toolkit 13.0 at ${CUDA_PATH}"
  fi

  if container_toolkit_ok; then
    echo "OK: NVIDIA Container Toolkit ${CONTAINER_TOOLKIT_VERSION_BARE}"
  else
    echo "MISSING: NVIDIA Container Toolkit ${CONTAINER_TOOLKIT_VERSION_BARE}"
  fi

  if [[ "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ]]; then
    if ! docker_installed_ok; then
      echo "MISSING: Docker is not installed."
      case "$PKG_FAMILY" in
        debian)
          echo "         Rerun with --install (not --skip-docker-install) to install"
          echo "         '${DOCKER_PACKAGE_DEBIAN}' via apt and finish the NVIDIA runtime wiring."
          ;;
        rhel)
          echo "         Rerun with --install (not --skip-docker-install) to install"
          echo "         docker-ce / moby-engine via ${PKG_MANAGER} and finish the NVIDIA runtime wiring."
          ;;
        suse)
          echo "         Rerun with --install (not --skip-docker-install) to install"
          echo "         'docker' via zypper and finish the NVIDIA runtime wiring."
          ;;
        arch)
          echo "         Install Docker manually for Arch-family hosts:"
          echo "             sudo pacman -S docker && sudo systemctl enable --now docker"
          echo "         Then rerun this script to wire the NVIDIA Container Toolkit runtime."
          ;;
        *)
          echo "         Install Docker for your distribution (see"
          echo "         https://docs.docker.com/engine/install/), then rerun this script."
          ;;
      esac
    elif docker_runtime_ok; then
      echo "OK: Docker NVIDIA runtime configured"
    else
      echo "MISSING: Docker NVIDIA runtime not configured or Docker unreachable"
    fi
  fi

  if [[ "$BACKEND" == "kubernetes" || "$BACKEND" == "k8s" ]]; then
    if kubernetes_gpu_ok; then
      echo "OK: Kubernetes reports nvidia.com/gpu allocatable"
    else
      local rc=$?
      if [[ "$rc" -eq 2 ]]; then
        echo "WARN: kubectl not found; cannot check cluster GPU capacity"
      else
        echo "WARN: Kubernetes does not report nvidia.com/gpu allocatable"
      fi
    fi
  fi

  if [[ -n "$PKG_FAMILY" && "$PKG_FAMILY" != "unknown" ]]; then
    echo "INFO: detected ${DISTRO_PRETTY} (family=${PKG_FAMILY}, manager=${PKG_MANAGER:-n/a})"
  elif [[ -n "$DISTRO_PRETTY" ]]; then
    echo "INFO: detected ${DISTRO_PRETTY} (family=unknown — --install will print manual steps)"
  fi
}

runtime_ok() {
  driver_ok && cuda_ok && container_toolkit_ok || return 1
  if [[ "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ]]; then
    docker_runtime_ok
    return $?
  fi
  return 0
}

unsupported_install_family() {
  local nct_ver="${CONTAINER_TOOLKIT_VERSION_BARE}"
  cat >&2 <<EOF
ERROR: --install does not yet automate this distribution.
       Detected: ${DISTRO_PRETTY:-unknown} (family=${PKG_FAMILY:-unknown})

Install these manually using your distribution's package manager, then rerun
this script with --check-only to verify:

  - NVIDIA driver branch ${DRIVER_BRANCH} (open kernel module preferred)
  - CUDA Toolkit 13.0 (NVIDIA package: ${CUDA_PACKAGE})
  - NVIDIA Container Toolkit ${nct_ver}
  - Docker engine (any flavor)

NVIDIA documentation:
  - CUDA install guide (all distros):
      https://docs.nvidia.com/cuda/cuda-installation-guide-linux/
  - NVIDIA Container Toolkit install guide:
      https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
  - Docker engine install guide (per distro):
      https://docs.docker.com/engine/install/

Tip: this skill bank's containerized workflows themselves are distribution-
agnostic — the only host-side requirement is a working Docker daemon plus
the NVIDIA Container Toolkit. Once those are in place, no further host
Python / apt / dnf prerequisites are needed.
EOF
  exit 1
}

confirm_install() {
  if [[ "$YES" -eq 1 ]]; then
    return 0
  fi

  local driver_line cuda_line nct_line docker_line=""
  case "$PKG_FAMILY" in
    debian)
      driver_line="${DRIVER_PACKAGE_DEBIAN} (driver branch ${DRIVER_BRANCH})"
      cuda_line="${CUDA_PACKAGE}"
      nct_line="nvidia-container-toolkit=${CONTAINER_TOOLKIT_VERSION}"
      if [[ ( "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ) \
            && "$INSTALL_DOCKER" -eq 1 ]] && ! have docker; then
        docker_line="
  - ${DOCKER_PACKAGE_DEBIAN} (Docker engine, distribution apt repo)"
      fi
      ;;
    rhel)
      driver_line="${DRIVER_PACKAGE_RHEL} + ${DRIVER_KMOD_RHEL} (driver branch ${DRIVER_BRANCH}, from NVIDIA CUDA repo)"
      cuda_line="${CUDA_PACKAGE}"
      nct_line="nvidia-container-toolkit-${CONTAINER_TOOLKIT_VERSION_BARE}"
      if [[ ( "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ) \
            && "$INSTALL_DOCKER" -eq 1 ]] && ! have docker; then
        case "$DISTRO_ID" in
          fedora) docker_line="
  - moby-engine + moby-cli (Fedora) — falls back to docker-ce from download.docker.com" ;;
          *)      docker_line="
  - docker-ce docker-ce-cli containerd.io (from download.docker.com)" ;;
        esac
      fi
      ;;
    suse)
      driver_line="${DRIVER_PACKAGE_SUSE} (driver branch ${DRIVER_BRANCH}, from NVIDIA CUDA repo)"
      cuda_line="${CUDA_PACKAGE}"
      nct_line="nvidia-container-toolkit-${CONTAINER_TOOLKIT_VERSION_BARE}"
      if [[ ( "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ) \
            && "$INSTALL_DOCKER" -eq 1 ]] && ! have docker; then
        docker_line="
  - docker (zypper)"
      fi
      ;;
    *)
      unsupported_install_family
      ;;
  esac

  cat <<EOF
Detected: ${DISTRO_PRETTY:-unknown} — family=${PKG_FAMILY}, manager=${PKG_MANAGER}

This will install or repair:
  - ${driver_line}
  - ${cuda_line}
  - ${nct_line}${docker_line}

It will add NVIDIA's CUDA + Container Toolkit repositories if missing, and
may restart Docker. If your invoking user is not already in the 'docker'
group, it will be added (log out / 'newgrp docker' for that to take effect).
EOF
  read -r -p "Continue? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
}

install_prereqs() {
  case "$PKG_FAMILY" in
    debian)
      export DEBIAN_FRONTEND=noninteractive
      "${SUDO[@]}" apt-get update
      "${SUDO[@]}" apt-get install -y --no-install-recommends ca-certificates curl gnupg
      ;;
    rhel)
      "${SUDO[@]}" "$PKG_MANAGER" -y install ca-certificates curl
      # dnf-plugins-core is required for `dnf config-manager --add-repo` on
      # RHEL/Rocky/Alma; Fedora ships it by default. Silently best-effort.
      "${SUDO[@]}" "$PKG_MANAGER" -y install dnf-plugins-core >/dev/null 2>&1 \
        || "${SUDO[@]}" "$PKG_MANAGER" -y install yum-utils >/dev/null 2>&1 \
        || true
      ;;
    suse)
      "${SUDO[@]}" zypper --non-interactive refresh
      "${SUDO[@]}" zypper --non-interactive install ca-certificates curl gpg2
      ;;
    *)
      unsupported_install_family
      ;;
  esac
}

install_cuda_repo() {
  [[ -n "$CUDA_REPO_DISTRO" && -n "$CUDA_REPO_ARCH" ]] || {
    echo "ERROR: cannot map ${DISTRO_PRETTY} to an NVIDIA CUDA repo path." >&2
    unsupported_install_family
  }

  case "$PKG_FAMILY" in
    debian)
      if dpkg-query -W cuda-keyring >/dev/null 2>&1; then
        return 0
      fi
      local deb
      deb="$(mktemp)"
      curl -fsSL \
        "https://developer.download.nvidia.com/compute/cuda/repos/${CUDA_REPO_DISTRO}/${CUDA_REPO_ARCH}/cuda-keyring_1.1-1_all.deb" \
        --output "$deb"
      "${SUDO[@]}" dpkg -i "$deb"
      rm -f "$deb"
      ;;
    rhel)
      local repo_file="/etc/yum.repos.d/cuda-${CUDA_REPO_DISTRO}.repo"
      if [[ -f "$repo_file" ]]; then
        return 0
      fi
      local repo_url="https://developer.download.nvidia.com/compute/cuda/repos/${CUDA_REPO_DISTRO}/${CUDA_REPO_ARCH}/cuda-${CUDA_REPO_DISTRO}.repo"
      if "${SUDO[@]}" "$PKG_MANAGER" config-manager --add-repo "$repo_url" >/dev/null 2>&1; then
        :
      else
        # Fallback: drop the .repo file directly if config-manager is unavailable.
        "${SUDO[@]}" curl -fsSL "$repo_url" -o "$repo_file"
      fi
      "${SUDO[@]}" "$PKG_MANAGER" clean expire-cache >/dev/null 2>&1 || true
      ;;
    suse)
      local repo_url="https://developer.download.nvidia.com/compute/cuda/repos/${CUDA_REPO_DISTRO}/${CUDA_REPO_ARCH}/cuda-${CUDA_REPO_DISTRO}.repo"
      if zypper lr --uri 2>/dev/null | grep -q "$repo_url"; then
        return 0
      fi
      "${SUDO[@]}" zypper --non-interactive addrepo --gpgcheck-strict "$repo_url"
      "${SUDO[@]}" zypper --non-interactive --gpg-auto-import-keys refresh
      ;;
    *)
      unsupported_install_family
      ;;
  esac
}

install_container_repo() {
  case "$PKG_FAMILY" in
    debian)
      local key_tmp keyring_tmp list_tmp
      key_tmp="$(mktemp)"
      keyring_tmp="$(mktemp)"
      list_tmp="$(mktemp)"

      curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey --output "$key_tmp"
      gpg --dearmor --yes --output "$keyring_tmp" "$key_tmp"
      "${SUDO[@]}" install -m 0644 "$keyring_tmp" /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

      curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list --output "$list_tmp"
      sed -i 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' "$list_tmp"
      "${SUDO[@]}" install -m 0644 "$list_tmp" /etc/apt/sources.list.d/nvidia-container-toolkit.list

      rm -f "$key_tmp" "$keyring_tmp" "$list_tmp"
      ;;
    rhel)
      local repo_file="/etc/yum.repos.d/nvidia-container-toolkit.repo"
      [[ -f "$repo_file" ]] && return 0
      "${SUDO[@]}" curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
        -o "$repo_file"
      ;;
    suse)
      local repo_url="https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo"
      if zypper lr --uri 2>/dev/null | grep -q "$repo_url"; then
        return 0
      fi
      "${SUDO[@]}" zypper --non-interactive addrepo --gpgcheck-strict "$repo_url"
      "${SUDO[@]}" zypper --non-interactive --gpg-auto-import-keys refresh
      ;;
    *)
      unsupported_install_family
      ;;
  esac
}

install_runtime_packages() {
  case "$PKG_FAMILY" in
    debian)
      export DEBIAN_FRONTEND=noninteractive
      local kernel_headers
      kernel_headers="linux-headers-$(uname -r)"
      "${SUDO[@]}" apt-get update
      "${SUDO[@]}" apt-get install -y --allow-downgrades \
        "$kernel_headers" \
        "nvidia-driver-pinning-${DRIVER_BRANCH}" \
        "$DRIVER_PACKAGE_DEBIAN" \
        "$CUDA_PACKAGE" \
        "nvidia-container-toolkit=${CONTAINER_TOOLKIT_VERSION}" \
        "nvidia-container-toolkit-base=${CONTAINER_TOOLKIT_VERSION}" \
        "libnvidia-container-tools=${CONTAINER_TOOLKIT_VERSION}" \
        "libnvidia-container1=${CONTAINER_TOOLKIT_VERSION}"
      ;;
    rhel)
      local ver="${CONTAINER_TOOLKIT_VERSION_BARE}"
      # Kernel headers/devel package names match the running kernel.
      "${SUDO[@]}" "$PKG_MANAGER" -y install \
        "kernel-devel-$(uname -r)" \
        "kernel-headers-$(uname -r)" || true
      "${SUDO[@]}" "$PKG_MANAGER" -y install --allowerasing \
        "$DRIVER_PACKAGE_RHEL" \
        "$DRIVER_KMOD_RHEL" \
        "$CUDA_PACKAGE" \
        "nvidia-container-toolkit-${ver}" \
        "nvidia-container-toolkit-base-${ver}" \
        "libnvidia-container-tools-${ver}" \
        "libnvidia-container1-${ver}"
      ;;
    suse)
      local ver="${CONTAINER_TOOLKIT_VERSION_BARE}"
      "${SUDO[@]}" zypper --non-interactive install --allow-downgrade \
        "kernel-default-devel" \
        "$DRIVER_PACKAGE_SUSE" \
        "$CUDA_PACKAGE" \
        "nvidia-container-toolkit-${ver}" \
        "nvidia-container-toolkit-base-${ver}" \
        "libnvidia-container-tools-${ver}" \
        "libnvidia-container1-${ver}"
      ;;
    *)
      unsupported_install_family
      ;;
  esac
}

install_docker_package() {
  [[ "$INSTALL_DOCKER" -eq 1 ]] || return 0
  [[ "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ]] || return 0
  have docker && return 0

  case "$PKG_FAMILY" in
    debian)
      echo "Installing Docker package '${DOCKER_PACKAGE_DEBIAN}' (apt)..."
      export DEBIAN_FRONTEND=noninteractive
      "${SUDO[@]}" apt-get install -y --no-install-recommends "$DOCKER_PACKAGE_DEBIAN"
      ;;
    rhel)
      if [[ "$DISTRO_ID" == "fedora" ]] \
         && "${SUDO[@]}" "$PKG_MANAGER" -y install moby-engine moby-cli 2>/dev/null; then
        echo "Installed Fedora's moby-engine + moby-cli."
      else
        echo "Installing docker-ce from download.docker.com ..."
        local docker_repo
        case "$DISTRO_ID" in
          fedora) docker_repo="https://download.docker.com/linux/fedora/docker-ce.repo" ;;
          *)      docker_repo="https://download.docker.com/linux/centos/docker-ce.repo" ;;
        esac
        if ! "${SUDO[@]}" "$PKG_MANAGER" config-manager --add-repo "$docker_repo" >/dev/null 2>&1; then
          "${SUDO[@]}" curl -fsSL "$docker_repo" -o /etc/yum.repos.d/docker-ce.repo
        fi
        "${SUDO[@]}" "$PKG_MANAGER" -y install docker-ce docker-ce-cli containerd.io
      fi
      ;;
    suse)
      echo "Installing Docker via zypper..."
      "${SUDO[@]}" zypper --non-interactive install docker
      ;;
    *)
      echo "WARN: --install cannot auto-install Docker on family '${PKG_FAMILY}'."
      echo "      Install Docker manually per https://docs.docker.com/engine/install/ ,"
      echo "      then rerun this script to finish wiring the NVIDIA runtime."
      return 0
      ;;
  esac

  if have systemctl; then
    "${SUDO[@]}" systemctl enable --now docker || {
      echo "WARN: could not enable/start docker via systemctl; start it manually."
    }
  fi
}

add_invoker_to_docker_group() {
  [[ "$ADD_USER_TO_DOCKER_GROUP" -eq 1 ]] || return 0
  [[ "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ]] || return 0
  have docker || return 0

  # Resolve the user that invoked us:
  #   - via sudo:        EUID=0, SUDO_USER=<original>  → use SUDO_USER
  #   - as non-root:     EUID!=0, SUDO_USER unset       → use $USER
  #   - as raw root:     EUID=0,  SUDO_USER unset       → $USER=root → skip
  local target_user="${SUDO_USER:-$USER}"
  [[ -n "$target_user" && "$target_user" != "root" ]] || return 0

  if ! getent group docker >/dev/null 2>&1; then
    "${SUDO[@]}" groupadd docker || return 0
  fi

  if id -nG "$target_user" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
    return 0
  fi

  "${SUDO[@]}" usermod -aG docker "$target_user" || return 0
  echo "NOTE: Added '${target_user}' to the 'docker' group. The new membership"
  echo "      does NOT take effect in this shell. To use docker without sudo,"
  echo "      log out and back in, or run 'newgrp docker' in each new shell."
}

configure_docker_runtime() {
  [[ "$CONFIGURE_DOCKER" -eq 1 ]] || return 0
  [[ "$BACKEND" == "docker" || "$BACKEND" == "local-docker" ]] || return 0

  if ! have docker; then
    if [[ "$INSTALL_DOCKER" -eq 0 ]]; then
      echo "WARN: Docker is not installed and --skip-docker-install was passed;"
      echo "      install Docker manually, then rerun this script to wire the"
      echo "      NVIDIA Container Toolkit runtime into /etc/docker/daemon.json."
    else
      echo "WARN: Docker is still not installed; skipping NVIDIA runtime configuration."
    fi
    return 0
  fi

  "${SUDO[@]}" nvidia-ctk runtime configure --runtime=docker
  if have systemctl; then
    "${SUDO[@]}" systemctl restart docker || {
      echo "WARN: could not restart Docker; restart it manually before running GPU containers."
    }
  else
    echo "WARN: systemctl not found; restart Docker manually before running GPU containers."
  fi
}

detect_distro

if [[ "$INSTALL" -eq 0 ]]; then
  print_status
  if runtime_ok; then
    exit 0
  fi
  echo
  case "$PKG_FAMILY" in
    debian|rhel|suse)
      echo "Run with --install --yes after user approval to install the pinned runtime."
      ;;
    *)
      echo "Automatic install is not available for this distribution. See the"
      echo "MISSING messages above and the NVIDIA install guides at"
      echo "  https://docs.nvidia.com/cuda/cuda-installation-guide-linux/"
      echo "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
      ;;
  esac
  exit 1
fi

if ! sudo_available; then
  echo "MISSING: passwordless sudo/root is required for runtime installation." >&2
  exit 1
fi

case "$PKG_FAMILY" in
  debian|rhel|suse) ;;
  *) unsupported_install_family ;;
esac

confirm_install
install_prereqs
install_cuda_repo
install_container_repo
install_runtime_packages
install_docker_package
configure_docker_runtime
add_invoker_to_docker_group

if have modprobe; then
  "${SUDO[@]}" modprobe nvidia || true
fi

print_status
runtime_ok
