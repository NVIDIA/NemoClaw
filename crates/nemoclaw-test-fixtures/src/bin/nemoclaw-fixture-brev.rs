// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Harmless command boundary for the Brev script regression tests.
//! Never invokes SSH, Brev, package tools, or any other host command.

use std::{
    env, fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

fn root() -> PathBuf {
    PathBuf::from(env::var_os("BREV_FIXTURE_ROOT").expect("only run inside the Brev fixture"))
}

fn record(name: &str, args: &[String]) {
    let mut event = vec![name.to_owned()];
    event.extend_from_slice(args);
    let mut line = serde_json::to_vec(&event).unwrap();
    line.push(b'\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root().join("events"))
        .unwrap()
        .write_all(&line)
        .unwrap();
}

fn count(name: &str) -> usize {
    let path = root().join(format!("{name}.count"));
    let n = fs::read_to_string(&path)
        .ok()
        .map(|s| s.parse::<usize>().unwrap())
        .unwrap_or(0)
        + 1;
    fs::write(path, n.to_string()).unwrap();
    n
}

fn setting(name: &str) -> usize {
    env::var(name).ok().map(|s| s.parse().unwrap()).unwrap_or(0)
}

fn stdin_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    io::stdin().read_to_end(&mut bytes).unwrap();
    bytes
}

fn ssh(args: &[String]) -> i32 {
    let remote = args.last().unwrap().as_str();
    match remote {
        "true" => {
            record("ready", &[]);
            if count("ready") <= setting("READY_FAILURES") {
                return 255;
            }
        }
        "bash -s" => {
            record("bootstrap", &[]);
            fs::write(root().join("bootstrap.stdin"), stdin_bytes()).unwrap();
            if setting("BOOTSTRAP_DISCONNECT") != 0 {
                return 255;
            }
            fs::write(root().join("ready"), "").unwrap();
        }
        "test -f /var/run/nemoclaw-brev-v1-ready" => {
            record("sentinel", &[]);
            if !root().join("ready").exists() || setting("MISSING_SENTINEL") != 0 {
                return 1;
            }
        }
        "printf %s \"$HOME\"" => {
            record("home", &[]);
            if count("home") <= setting("HOME_FAILURES") {
                return 255;
            }
            print!("{}", env::var("REMOTE_HOME").unwrap_or("/home/brev".into()));
        }
        command if command.contains("brev-v1-guest.sh") => {
            record("lifecycle", &[command.to_owned()]);
            if setting("LIFECYCLE_DISCONNECT") != 0 {
                return 255;
            }
        }
        command
            if command.starts_with("sudo usermod ")
                || command.starts_with("sg docker ")
                || command.starts_with("install -d ")
                || command.starts_with("tail -20 ") => {}
        _ => panic!("unexpected remote command: {remote}"),
    }
    0
}

fn dispatch(name: &str, args: &[String], elevated: bool) -> i32 {
    record(name, args);
    if elevated {
        let mut call = vec![name.to_owned()];
        call.extend_from_slice(args);
        record("elevated", &call);
    }
    match name {
        "brev" => match args[0].as_str() {
            "search" => println!("fake offer"),
            "create" => {
                stdin_bytes();
            }
            "refresh" => {
                println!("refresh diagnostic");
                return setting("REFRESH_STATUS") as i32;
            }
            _ => panic!("unexpected Brev command: {args:?}"),
        },
        "ssh" => return ssh(args),
        "git" => match args[0].as_str() {
            "rev-parse" => println!("{}", "a".repeat(40)),
            "archive" => println!("fake candidate source"),
            _ => panic!("unexpected git command"),
        },
        "gzip" => {
            io::stdout().write_all(&stdin_bytes()).unwrap();
        }
        "rsync" | "sleep" => {}
        "id" => match args[0].as_str() {
            "-u" => println!("1000"),
            "-un" => println!("brev"),
            _ => panic!("unexpected id command"),
        },
        "sudo" => return dispatch(&args[0], &args[1..], true),
        "tee" => {
            io::stdout().write_all(&stdin_bytes()).unwrap();
        }
        "fuser" => {
            // Without elevation, an unprivileged probe cannot see the lock owner.
            if !elevated {
                return 1;
            }
            if env::var("APT_BUSY_LOCK").ok().as_ref() == args.first()
                && count("apt-lock") <= setting("APT_BUSY_PROBES")
            {
                return 0;
            }
            return 1;
        }
        "apt-get" => {
            assert!(elevated);
            if env::var_os("APT_BUSY_LOCK").is_some() {
                let probes = fs::read_to_string(root().join("apt-lock.count"))
                    .unwrap_or("0".into())
                    .parse::<usize>()
                    .unwrap();
                if probes <= setting("APT_BUSY_PROBES") {
                    eprintln!("fake apt: lock held by another process");
                    return 100;
                }
            }
            if args.iter().any(|arg| arg == "docker.io") {
                fs::copy(env::current_exe().unwrap(), root().join("bin/docker")).unwrap();
            }
            if args
                .iter()
                .any(|arg| arg == "docker-buildx-plugin" || arg == "docker-buildx")
            {
                fs::write(root().join("buildx"), "").unwrap();
            }
        }
        "apt-cache" => {
            return if args.last().unwrap()
                == &env::var("BUILDX_PACKAGE").unwrap_or("docker-buildx-plugin".into())
            {
                0
            } else {
                1
            };
        }
        "docker" => {
            assert!(elevated);
            if args[0] == "buildx" && !root().join("buildx").exists() {
                return 1;
            }
        }
        "systemctl" | "usermod" => {
            assert!(elevated);
        }
        "install" => {
            assert!(elevated);
            assert_eq!(args.last().unwrap(), "/var/run/nemoclaw-brev-v1-ready");
            fs::write(root().join("sentinel"), "").unwrap();
        }
        "seq" => {
            for n in args[0].parse::<usize>().unwrap()..=args[1].parse().unwrap() {
                println!("{n}");
            }
        }
        // Local credential/evidence operations stay inside the temporary fixture.
        "rm" | "mkdir" => {
            for arg in args.iter().filter(|arg| !arg.starts_with('-')) {
                let path = Path::new(arg);
                assert!(
                    path.starts_with(root()),
                    "refusing a path outside the fixture"
                );
                if name == "rm" {
                    if path.exists() {
                        fs::remove_file(path).unwrap();
                    }
                } else {
                    fs::create_dir_all(path).unwrap();
                }
            }
        }
        _ => panic!("unexpected fixture command: {name}"),
    }
    0
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let name = Path::new(&args[0]).file_name().unwrap().to_str().unwrap();
    std::process::exit(dispatch(name, &args[1..], false));
}
