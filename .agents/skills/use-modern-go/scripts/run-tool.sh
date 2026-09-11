#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"

cli_version="$(cat "${script_dir}/VERSION")"
module_path="github.com/JetBrains/go-modern-guidelines"
binary_name="go-modern-guidelines"

if [ -n "${XDG_CACHE_HOME:-}" ]; then
	cache_root="${XDG_CACHE_HOME}/go-modern-guidelines"
elif [ -n "${HOME:-}" ]; then
	cache_root="${HOME}/.cache/go-modern-guidelines"
else
	echo "go-modern-guidelines: HOME or XDG_CACHE_HOME must be set" >&2
	exit 1
fi

# GO_MODERN_GUIDELINES_DEV runs the binary built by make dev-install.
if [ -n "${GO_MODERN_GUIDELINES_DEV:-}" ]; then
	dev_binary="${cache_root}/dev/${binary_name}"
	if [ ! -x "${dev_binary}" ]; then
		echo "go-modern-guidelines: GO_MODERN_GUIDELINES_DEV is set but no dev build found; run make dev-install" >&2
		exit 1
	fi
	exec "${dev_binary}" "$@"
fi

install_dir="${cache_root}/${cli_version}"
binary_path="${install_dir}/${binary_name}"

if [ ! -x "${binary_path}" ]; then
	if ! command -v go >/dev/null 2>&1; then
		echo "go-modern-guidelines: Go toolchain is required to install ${module_path}@${cli_version}" >&2
		exit 1
	fi

	tmp_dir="${install_dir}.tmp.$$"
	rm -rf "${tmp_dir}"
	mkdir -p "${tmp_dir}"
	trap 'rm -rf "${tmp_dir}"' EXIT HUP INT TERM

	echo "go-modern-guidelines: installing ${module_path}@${cli_version} into ${install_dir}" >&2

	(
		cd "${tmp_dir}"
		GOFLAGS= GOWORK=off CGO_ENABLED=0 GOBIN="${tmp_dir}" go install "${module_path}@${cli_version}"
	)

	tmp_binary="${tmp_dir}/${binary_name}"
	if [ ! -x "${tmp_binary}" ]; then
		echo "go-modern-guidelines: go install did not produce ${binary_name}" >&2
		exit 1
	fi

	actual_version="$("${tmp_binary}" --version 2>/dev/null || true)"
	if [ "${actual_version}" != "${cli_version}" ]; then
		echo "go-modern-guidelines: installed ${actual_version:-unknown version}, want ${cli_version}" >&2
		exit 1
	fi

	mkdir -p "${install_dir}"
	mv "${tmp_binary}" "${binary_path}.tmp.$$"
	mv "${binary_path}.tmp.$$" "${binary_path}"
	rm -rf "${tmp_dir}"
fi

exec "${binary_path}" "$@"
