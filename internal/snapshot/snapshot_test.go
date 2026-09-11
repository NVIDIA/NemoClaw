// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package snapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func manifest(data string) Manifest {
	h := sha256.Sum256([]byte(data))
	return Manifest{Repository: "owner/model", Revision: strings.Repeat("a", 40), Files: []File{{Name: "weights.bin", Size: int64(len(data)), SHA256: hex.EncodeToString(h[:])}}}
}

func TestInterruptedDownloadResumesExactSnapshotAndNoOpMakesNoRequests(t *testing.T) {
	data := "the pinned model snapshot"
	m := manifest(data)
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/owner/model/resolve/"+m.Revision+"/weights.bin" {
			t.Errorf("unexpected revision: %s", r.URL.Path)
		}
		switch calls.Add(1) {
		case 1:
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			fmt.Fprint(w, data[:7])
		case 2:
			if r.Header.Get("Range") != "bytes=7-" {
				t.Errorf("range: %s", r.Header.Get("Range"))
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 7-%d/%d", len(data)-1, len(data)))
			w.WriteHeader(http.StatusPartialContent)
			fmt.Fprint(w, data[7:])
		default:
			t.Error("unchanged apply downloaded again")
		}
	}))
	defer s.Close()
	c := Client{BaseURL: s.URL, HTTP: s.Client()}
	dir := t.TempDir()
	if _, err := c.Ensure(t.Context(), dir, m, nil); err == nil {
		t.Fatal("accepted interrupted stream")
	}
	if _, err := Observe(dir, m); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("published incomplete snapshot: %v", err)
	}
	if _, err := c.Ensure(t.Context(), dir, m, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Observe(dir, m); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ensure(t.Context(), dir, m, nil); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("unexpected download count")
	}
}

func TestFailedObservationDoesNotDownloadOrAcceptCorruptData(t *testing.T) {
	m := manifest("right")
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "weights.bin"), []byte("wrong"), 0600); err != nil {
		t.Fatal(err)
	}
	s := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("corruption triggered replacement download") }))
	defer s.Close()
	c := Client{BaseURL: s.URL, HTTP: s.Client()}
	if _, err := c.Ensure(t.Context(), dir, m, nil); err == nil {
		t.Fatal("accepted unverified existing data")
	}
	b, err := os.ReadFile(filepath.Join(dir, "weights.bin"))
	if err != nil || string(b) != "wrong" {
		t.Fatal("lost established data")
	}
}

func TestResumeRequiresConfirmedRangeAndChecksum(t *testing.T) {
	for _, scenario := range []string{"authentication", "range ignored", "wrong checksum", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			m := manifest("right")
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "weights.bin.nemoclaw-partial"), []byte("ri"), 0600); err != nil {
				t.Fatal(err)
			}
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch scenario {
				case "authentication":
					w.WriteHeader(http.StatusUnauthorized)
				case "range ignored":
					fmt.Fprint(w, "right")
				default:
					w.Header().Set("Content-Range", "bytes 2-4/5")
					w.WriteHeader(http.StatusPartialContent)
					if scenario == "wrong checksum" {
						fmt.Fprint(w, "bad")
					} else {
						fmt.Fprint(w, "g")
					}
				}
			}))
			defer s.Close()
			c := Client{BaseURL: s.URL, HTTP: s.Client()}
			if _, err := c.Ensure(t.Context(), dir, m, nil); err == nil {
				t.Fatal("accepted failed observation")
			}
			if _, err := os.Stat(filepath.Join(dir, ".nemoclaw-complete.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("published completion")
			}
			if _, err := os.Stat(filepath.Join(dir, "weights.bin.nemoclaw-partial")); err != nil {
				t.Fatal("lost resumable data")
			}
		})
	}
}

func TestIncompleteManifestNeverPublishesCompletion(t *testing.T) {
	m := manifest("right")
	m.Files = append(m.Files, File{Name: "second.bin", Size: m.Files[0].Size, SHA256: m.Files[0].SHA256})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "second.bin") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		fmt.Fprint(w, "right")
	}))
	defer s.Close()
	dir := t.TempDir()
	c := Client{BaseURL: s.URL, HTTP: s.Client()}
	if _, err := c.Ensure(t.Context(), dir, m, nil); err == nil {
		t.Fatal("accepted partial result")
	}
	if _, err := Observe(dir, m); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partial snapshot marked complete")
	}
	if _, err := os.Stat(filepath.Join(dir, "weights.bin")); err != nil {
		t.Fatal("lost completed file")
	}
}
