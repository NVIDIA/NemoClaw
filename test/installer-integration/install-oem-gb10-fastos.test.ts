// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInstallerSourced } from "../helpers/installer-express-prompt-harness";

describe("installer OEM GB10 FastOS detection", () => {
  it("recognizes an OEM GB10 from its trusted DGX Spark FastOS marker (#10717)", () => {
    const result = runInstallerSourced(`
test_marker="$HOME/fastos-release"
printf 'NAME="DGX SPARK FASTOS"\\nVERSION="1.135.16"\\n' >"$test_marker"
n1x_fastos_release_path() { printf "%s" "$test_marker"; }
stat() {
  case "$1:$3" in
    -c:"$test_marker"|-Lc:/proc/self/fd/*) ;;
    *) command stat "$@"; return ;;
  esac
  printf '81a4:0:0:644:47:1:2'
}
function [ {
  if [[ "$#" -eq 3 && "$1" = "-r" && "$2" = "/sys/class/dmi/id/product_name" && "$3" = "]" ]]; then
    return 0
  fi
  builtin [ "$@"
}
cat() {
  if [[ "$#" -eq 1 && "$1" = "/sys/class/dmi/id/product_name" ]]; then
    printf "OEM GB10 system"
    return
  fi
  command cat "$@"
}
is_wsl_host() { return 1; }
uname() {
  case "$1" in
    -s) printf "Linux" ;;
    -m) printf "aarch64" ;;
  esac
}
detect_express_platform
`);

    expect(result.result.status, result.output).toBe(0);
    expect(result.result.stdout).toBe("DGX Spark");
  });
});
