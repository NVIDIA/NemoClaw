// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [operation, uid, gid] if operation == "install" => {
            match (uid.parse::<u32>(), gid.parse::<u32>()) {
                (Ok(uid), Ok(gid)) => nemoclaw_container_inputs::run(uid, gid),
                _ => Err("protected input setup arguments are invalid"),
            }
        }
        _ => Err("protected input setup arguments are invalid"),
    };
    if result.is_err() {
        // Docker may retain process output. Never print a request, path, or OS diagnostic.
        eprintln!("protected input setup failed");
        std::process::exit(1);
    }
}
