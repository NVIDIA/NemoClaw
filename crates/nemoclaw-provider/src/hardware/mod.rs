// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub use nemoclaw_runtime::hardware::*;

mod observation;
#[cfg(unix)]
pub(crate) use observation::LocalHost;
pub use observation::{HostObservation, HostObserver};

mod ssh;
pub use ssh::SshHost;

/// `nvidia::GPU_QUERY`'s rows for a host with two different GPUs: an H100 at
/// index 0 and an L4 at index 1.
#[cfg(all(test, target_os = "linux"))]
pub(crate) const TWO_GPUS: [&str; 2] = [
    "0, GPU-00000000-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, 81559, 81000, 580.65",
    "1, GPU-11111111-1111-1111-1111-111111111111, NVIDIA L4, 8.9, 23034, 22000, 580.65",
];

/// The body of a fake `nvidia-smi` that reports `rows` for `nvidia::GPU_QUERY`
/// and no GPU processes. `--id` selects one GPU by index or UUID; an unknown
/// one fails as `nvidia-smi` does.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn fake_nvidia_smi(rows: &[impl AsRef<str>]) -> String {
    let rows: Vec<&str> = rows.iter().map(AsRef::as_ref).collect();
    format!(
        r#"[ "$2" = --format=csv,noheader,nounits ] || exit 2
[ $# -le 3 ] || exit 2
case "$1" in
{gpus}) query=gpus ;;
{processes}) query=processes ;;
*) exit 2 ;;
esac
case "${{3-}}" in
'') id= ;;
--id=?*) id=${{3#--id=}} ;;
*) exit 2 ;;
esac
found=
while IFS= read -r row; do
  index=${{row%%,*}}
  uuid=${{row#*, }}
  uuid=${{uuid%%,*}}
  if [ -z "$id" ] || [ "$id" = "$index" ] || [ "$id" = "$uuid" ]; then
    found=1
    [ "$query" = processes ] || printf '%s\n' "$row"
  fi
done <<'EOF'
{rows}
EOF
[ -n "$found" ] || {{ echo 'No devices were found'; exit 6; }}
"#,
        gpus = nvidia::GPU_QUERY,
        processes = nvidia::PROCESS_QUERY,
        rows = rows.join("\n"),
    )
}
