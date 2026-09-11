// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type Manifest struct {
	Version, Go, OpenTofu, Osquery string
	Files                          map[string]string
}

func VerifyBundle(dir string) error {
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return errors.New("bundle manifest missing; run go run ./tools/bundle")
	}
	var m Manifest
	if json.Unmarshal(b, &m) != nil || m.OpenTofu != "1.12.6" || m.Osquery != "5.23.1" {
		return errors.New("incompatible bundle manifest")
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	for _, p := range []string{"bin/nemoclaw" + ext, "libexec/tofu" + ext, "libexec/osqueryi" + ext, "libexec/nemoclaw-osquery.ext" + ext, "providers/registry.opentofu.org/nvidia/nemoclaw/" + m.Version + "/" + runtime.GOOS + "_" + runtime.GOARCH + "/terraform-provider-nemoclaw_v" + m.Version + ext} {
		if m.Files[p] == "" {
			return errors.New("bundle is incomplete")
		}
	}
	for p, digest := range m.Files {
		if !filepath.IsLocal(p) {
			return errors.New("invalid bundle path")
		}
		f, err := os.Open(filepath.Join(dir, p))
		if err != nil {
			return errors.New("bundle file missing")
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		f.Close()
		if err != nil || hex.EncodeToString(h.Sum(nil)) != digest {
			return fmt.Errorf("bundle integrity check failed for %s", p)
		}
	}
	return nil
}
func executable(dir, name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(dir, "libexec", name)
}

func cleanEnv() []string {
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

func run(ctx context.Context, dir, binary string, env []string, args ...string) ([]byte, error) {
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

func (e *Engine) tofu(ctx context.Context, args ...string) ([]byte, error) {
	env := append(cleanEnv(), "TF_IN_AUTOMATION=1", "TF_INPUT=0", "TF_CLI_CONFIG_FILE="+filepath.Join(e.StateDir, "providers.tfrc"), "CHECKPOINT_DISABLE=1")
	return run(ctx, e.StateDir, executable(e.BundleDir, "tofu"), env, args...)
}
