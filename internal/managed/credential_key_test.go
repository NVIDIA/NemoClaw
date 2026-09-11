// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/moby/moby/client"
)

func TestLegacyKeyHandoffPrecedesDeletionWithoutDependingOnStorageCreate(t *testing.T) {
	for _, failure := range []string{"none", "already preserved", "different key", "missing legacy key", "authentication", "interrupted copy", "short key"} {
		t.Run(failure, func(t *testing.T) {
			legacy := bytes.Repeat([]byte{42}, 32)
			var persisted []byte
			writes := 0
			if failure == "already preserved" {
				persisted = bytes.Clone(legacy)
			}
			if failure == "different key" {
				persisted = bytes.Repeat([]byte{43}, 32)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/containers/verified-old-container/archive") {
					t.Error("unverified container access")
					w.WriteHeader(500)
					return
				}
				path := r.URL.Query().Get("path")
				if r.Method == "PUT" {
					writes++
					if failure == "interrupted copy" {
						w.WriteHeader(503)
						return
					}
					if path != "/owned-data" {
						t.Error("write escaped owned storage")
					}
					a := tar.NewReader(r.Body)
					for {
						h, err := a.Next()
						if err == io.EOF {
							break
						}
						if err != nil {
							t.Error(err)
							break
						}
						if h.Typeflag == tar.TypeDir {
							continue
						}
						if h.Name != credentialKeyPath[1:] || h.Mode != 0600 {
							t.Error("wrong credential destination or permissions")
						}
						persisted, err = io.ReadAll(a)
						if err != nil {
							t.Error(err)
						}
					}
					return
				}
				if r.Method != "GET" {
					t.Error("unexpected mutation")
					w.WriteHeader(500)
					return
				}
				data := persisted
				if strings.HasPrefix(path, "/root/") {
					data = legacy
					switch failure {
					case "missing legacy key":
						data = nil
					case "authentication":
						w.WriteHeader(403)
						return
					case "short key":
						data = []byte("short")
					}
				}
				if data == nil {
					w.WriteHeader(404)
					fmt.Fprint(w, `{"message":"absent"}`)
					return
				}
				w.Header().Set("X-Docker-Container-Path-Stat", "e30=")
				a := tar.NewWriter(w)
				a.WriteHeader(&tar.Header{Name: "key", Mode: 0600, Size: int64(len(data))})
				a.Write(data)
				a.Close()
			}))
			defer server.Close()
			api, err := client.New(client.WithHost(server.URL), client.WithAPIVersion("1.53"))
			if err != nil {
				t.Fatal(err)
			}
			defer api.Close()
			d := &Docker{API: api}
			err = d.preserveLegacyCredentialKey(t.Context(), &Observation{ContainerID: "verified-old-container", DataPath: "/owned-data"})
			if failure == "none" || failure == "already preserved" {
				if err != nil || !bytes.Equal(persisted, legacy) {
					t.Fatal("handoff lost the database encryption key", err)
				}
				wantWrites := 1
				if failure == "already preserved" {
					wantWrites = 0
				}
				if writes != wantWrites {
					t.Fatal("key was unnecessarily rewritten")
				}
			} else if err == nil {
				t.Fatal("unsafe deletion would be authorized")
			}
			if failure != "none" && failure != "interrupted copy" && writes != 0 {
				t.Fatal("failed observation or conflict overwrote a key")
			}
		})
	}
}
