// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const VLLM_DOCKER_STORAGE_NVIDIA_SMI_SOURCE = `#!/bin/sh
case "$#:$1:$2" in
  2:--query-gpu=compute_cap:--format=csv,noheader,nounits) printf '9.0\\n' ;;
  2:--query-gpu=index,uuid,memory.total,memory.free:--format=csv,noheader,nounits)
    printf '0, GPU-storage-proof, 131072, 131072\\n'
    ;;
  *) exit 64 ;;
esac
`;
