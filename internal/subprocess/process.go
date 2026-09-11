// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package subprocess

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func Executable(dir, name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, "libexec", name)
}

func CleanEnv() []string {
	var env []string
	for _, v := range os.Environ() {
		name, _, _ := strings.Cut(v, "=")
		n := strings.ToUpper(name)
		if strings.HasPrefix(n, "TF_") || strings.HasPrefix(n, "TOFU_") || strings.HasPrefix(n, "NEMOCLAW_INTERNAL_") {
			continue
		}
		env = append(env, v)
	}
	return env
}

func Run(ctx context.Context, dir, binary string, env []string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Dir = dir
	cmd.Env = env
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	prepareProcess(cmd)
	err := cmd.Run()
	finishProcess(cmd)
	if err != nil {
		if ctx.Err() != nil {
			return nil, errors.New("operation interrupted; retain state and reapply the same YAML")
		}
		msg := stderr.String()
		msg = msg[:min(len(msg), 16384)]
		// Credentials never enter configuration, but upstream diagnostics are still
		// treated as untrusted and redacted before reaching the terminal.
		for _, entry := range env {
			key, value, _ := strings.Cut(entry, "=")
			if len(value) > 3 && (strings.Contains(key, "KEY") || strings.Contains(key, "TOKEN") || strings.Contains(key, "SECRET") || strings.Contains(key, "PASSWORD")) {
				msg = strings.ReplaceAll(msg, value, "[redacted]")
			}
		}
		return nil, fmt.Errorf("%s failed: %s", filepath.Base(binary), strings.TrimSpace(msg))
	}
	return stdout.Bytes(), nil
}
