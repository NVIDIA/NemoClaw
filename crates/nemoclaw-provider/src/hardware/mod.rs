// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
pub use nemoclaw_runtime::hardware::*;

mod observation;
#[cfg(unix)]
pub(crate) use observation::LocalHost;
pub use observation::{HostObservation, HostObserver};

mod ssh;
pub use ssh::SshHost;

/// A fake `nvidia-smi` on a host with two different GPUs: an H100 at index 0
/// and an L4 at index 1. `--id` selects one; an unknown id fails as
/// `nvidia-smi` does.
#[cfg(all(test, target_os = "linux"))]
pub(crate) const TWO_GPUS: &str = r#"[ "$2" = --format=csv,noheader,nounits ] || exit 2
case "${3-}" in
'') id=all ;;
--id=0|--id=GPU-00000000-0000-0000-0000-000000000000) id=0 ;;
--id=1|--id=GPU-11111111-1111-1111-1111-111111111111) id=1 ;;
*) echo 'No devices were found'; exit 6 ;;
esac
[ $# -le 3 ] || exit 2
row() { [ "$id" = 1 ] || echo "$1"; [ "$id" = 0 ] || echo "$2"; }
case "$1" in
--query-gpu=name,driver_version) row 'NVIDIA H100 80GB HBM3, 580.65' 'NVIDIA L4, 580.65' ;;
--query-gpu=compute_cap) row 9.0 8.9 ;;
--query-gpu=memory.total,memory.free) row '81559, 81000' '23034, 22000' ;;
--query-compute-apps=pid) ;;
*) exit 2 ;;
esac
"#;
