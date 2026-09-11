// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"

	"github.com/NVIDIA/NemoClaw/internal/config"
)

type Record struct {
	Version     int               `json:"version"`
	Document    config.Document   `json:"document"`
	Generations map[string]string `json:"generations"`
	Pending     bool              `json:"pending"`
	Succeeded   bool              `json:"succeeded"`
	Digest      string            `json:"digest"`
	PlanDigest  string            `json:"planDigest,omitempty"`
}

func loadRecord(dir string) (Record, error) {
	var r Record
	b, err := os.ReadFile(filepath.Join(dir, "intent.json"))
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(b, &r); err != nil {
		return r, errors.New("deployment intent record is corrupt; retain it for recovery")
	}
	if r.Version != 1 || r.Document.Validate() != nil || r.Document.Digest() != r.Digest || len(r.Generations) != 3 {
		return r, errors.New("deployment intent record is invalid")
	}
	return r, nil
}
func saveJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(b, '\n'))
}
func atomicWrite(path string, b []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		dir, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		defer dir.Close()
		return dir.Sync()
	}
	return nil
}
