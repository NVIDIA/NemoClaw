// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func main() {
	if err := build(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build() error {
	if runtime.Version() != "go1.27.1" {
		return errors.New("Spark artifact requires Go 1.27.1")
	}
	dir := ".build/spark"
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-trimpath", "-buildvcs=false", "-ldflags=-buildid=", "-o", filepath.Join(dir, "nemoclaw-spark"), "./cmd/nemoclaw-spark")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH=arm64")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	f, err := os.Create(filepath.Join(dir, "supervisor-source.tar.gz"))
	if err != nil {
		return err
	}
	g := gzip.NewWriter(f)
	t := tar.NewWriter(g)
	err = filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != "." && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "dist") {
				return filepath.SkipDir
			}
			return nil
		}
		if path != "go.mod" && path != "go.sum" && path != "LICENSE" && !strings.HasPrefix(path, "cmd/nemoclaw-spark/") && !strings.HasPrefix(path, "internal/spark/") && !strings.HasPrefix(path, "internal/snapshot/") && !strings.HasPrefix(path, "tools/spark-runtime/") && !strings.HasPrefix(path, "runtimes/qwen38/") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err = t.WriteHeader(&tar.Header{Name: path, Mode: 0644, Size: int64(len(b)), ModTime: time.Unix(1788974180, 0)}); err != nil {
			return err
		}
		_, err = t.Write(b)
		return err
	})
	for _, close := range []func() error{t.Close, g.Close, f.Close} {
		if e := close(); err == nil {
			err = e
		}
	}
	if err != nil {
		return err
	}
	pins := map[string]string{"go": runtime.Version()}
	for _, name := range []string{"nemoclaw-spark", "supervisor-source.tar.gz"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		h := sha256.Sum256(b)
		pins[name] = hex.EncodeToString(h[:])
	}
	b, err := json.Marshal(pins)
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dir, "supervisor.json"), b, 0644); err != nil {
		return err
	}
	cmd = exec.Command("docker", "buildx", "build", "--provenance=false", "--output", "type=oci,dest=.build/spark/runtime.tar,rewrite-timestamp=true", "--build-arg", "SOURCE_DATE_EPOCH=1788974180", "-f", "runtimes/qwen38/Dockerfile", "-t", "nc-prototype-qwen38:spark-v1", ".")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err = cmd.Run(); err != nil {
		return err
	}
	cmd = exec.Command("docker", "load", "-i", ".build/spark/runtime.tar")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}
