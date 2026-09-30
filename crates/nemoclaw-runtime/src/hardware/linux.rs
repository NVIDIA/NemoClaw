// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::Capacity;
use crate::Error;
pub fn memory() -> Result<Capacity, Error> {
    let file = std::fs::File::open("/proc/meminfo")
        .map_err(|_| Error::State("host memory is unobservable"))?;
    super::read_memory(file)
}
