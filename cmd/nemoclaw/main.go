// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"syscall"

	"github.com/NVIDIA/NemoClaw/internal/engine"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 || !slices.Contains([]string{"apply", "plan", "export", "destroy"}, os.Args[1]) {
		return fmt.Errorf("usage: nemoclaw {apply|plan|export|destroy} [--state-dir DIR] [--file YAML]; plan --destroy previews teardown")
	}
	operation := os.Args[1]
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	f := flag.NewFlagSet(os.Args[1], flag.ContinueOnError)
	state := f.String("state-dir", ".nemoclaw", "persistent deployment state directory")
	bundle := f.String("bundle", filepath.Dir(filepath.Dir(exe)), "private bundle directory")
	file := f.String("file", "", "read YAML from a file instead of stdin")
	var destroy bool
	if operation == "plan" {
		f.BoolVar(&destroy, "destroy", false, "preview teardown of the selected deployment, retaining persistent data")
	}
	if err = f.Parse(os.Args[2:]); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	if destroy {
		operation = "plan-destroy"
	}
	input := os.Stdin
	if *file != "" {
		if operation != "plan" && operation != "apply" {
			return fmt.Errorf("%s uses the selected state directory and does not accept YAML input", os.Args[1])
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
	return e.Run(ctx, operation, input)
}
