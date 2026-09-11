// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/NVIDIA/NemoClaw/internal/engine"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 3 || os.Args[1] != "config" {
		return fmt.Errorf("usage: nemoclaw config {apply|plan|export} [--state-dir DIR] [--file YAML]")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	f := flag.NewFlagSet("config "+os.Args[2], flag.ContinueOnError)
	state := f.String("state-dir", ".nemoclaw", "persistent deployment state directory")
	bundle := f.String("bundle", filepath.Dir(filepath.Dir(exe)), "private bundle directory")
	file := f.String("file", "", "read YAML from a file instead of stdin")
	if err = f.Parse(os.Args[3:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	input := os.Stdin
	if *file != "" {
		if os.Args[2] == "export" {
			return fmt.Errorf("export writes YAML to stdout")
		}
		input, err = os.Open(*file)
		if err != nil {
			return err
		}
		defer input.Close()
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	e := engine.Engine{StateDir: *state, BundleDir: *bundle, Output: os.Stdout}
	return e.Run(ctx, os.Args[2], input)
}
