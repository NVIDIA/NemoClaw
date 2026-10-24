// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace NemoClaw.InstalledStop {
    // CI observation only: no termination, process-memory or permission-write API.
    public sealed class Snapshot : IDisposable {
        const uint Access = 0x00101000; // QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low, high; public ulong Value { get { return ((ulong)high << 32) | low; } } }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
            public uint size, usage, pid; public UIntPtr heap;
            public uint module, threads, parent; public int priority; public uint flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string image;
        }
        [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,int id);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out SafeProcessHandle target,uint access,bool inherit,uint options);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(SafeProcessHandle process,out uint code);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle process);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(SafeProcessHandle process,uint flags,StringBuilder text,ref int size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle process,uint milliseconds);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint id);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        delegate bool WindowCallback(IntPtr window,IntPtr context);
        [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr context);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window,WindowCallback callback,IntPtr context);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window,StringBuilder text,int count);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr window,StringBuilder text,int count);
        [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr window,uint message,UIntPtr count,StringBuilder text,uint flags,uint milliseconds,out UIntPtr result);

        sealed class Held : IDisposable {
            public readonly SafeProcessHandle handle;
            public readonly int pid;
            public int parent;
            public readonly string image;
            public readonly ulong created;
            public Held(SafeProcessHandle owned,int id,int parentId,string expectedImage,ulong expectedCreated) {
                handle=owned; pid=id; parent=parentId;
                try {
                    if(handle.IsInvalid || GetProcessId(handle)!=(uint)id) throw new Win32Exception();
                    int size=4096; var text=new StringBuilder(size);
                    if(!QueryFullProcessImageNameW(handle,0,text,ref size)) throw new Win32Exception();
                    image=text.ToString(); FileTime creation,exit,kernel,user;
                    if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) throw new Win32Exception();
                    created=creation.Value;
                    if(expectedImage!=null && !String.Equals(Path.GetFullPath(image),Path.GetFullPath(expectedImage),StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Held image changed.");
                    if(expectedCreated!=0 && created!=expectedCreated) throw new InvalidOperationException("Held creation changed.");
                } catch { handle.Dispose(); throw; }
            }
            public bool Alive() {
                uint wait=WaitForSingleObject(handle,0);
                if(wait==258)return true; if(wait==0)return false; throw new Win32Exception();
            }
            public ulong ExitTime() {
                FileTime creation,exit,kernel,user;
                if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user) || creation.Value!=created) throw new Win32Exception();
                return exit.Value;
            }
            public object Observe() {
                bool alive=Alive(); uint exitCode=0;
                if(!alive && !GetExitCodeProcess(handle,out exitCode)) throw new Win32Exception();
                return new { processId=pid,parentProcessId=parent,executable=image,creationFileTime=created.ToString(),alive,
                    exitCode=alive?(uint?)null:exitCode,exitFileTime=alive?null:ExitTime().ToString(),identityHeld=true };
            }
            public void Dispose(){handle.Dispose();}
        }
        readonly Dictionary<int,Held> held=new Dictionary<int,Held>();
        readonly int rootPid;
        public Snapshot(int rootId,IntPtr rootHandle,string rootImage,long rootCreated,int hostId,IntPtr hostHandle,string hostImage,long hostCreated) {
            rootPid=rootId;
            try { AddExisting(rootId,0,rootHandle,rootImage,(ulong)rootCreated); AddExisting(hostId,rootId,hostHandle,hostImage,(ulong)hostCreated); }
            catch { Dispose(); throw; }
        }
        void AddExisting(int id,int parent,IntPtr source,string image,ulong created) {
            SafeProcessHandle copy;
            if(!DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),out copy,Access,false,0))throw new Win32Exception();
            var process=new Held(copy,id,parent,image,created);
            try { held.Add(id,process); } catch { process.Dispose(); throw; }
        }
        static List<Entry> ProcessEntries() {
            IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
            if(snapshot==IntPtr.Zero || snapshot==new IntPtr(-1))throw new Win32Exception();
            try {
                var result=new List<Entry>(); var entry=new Entry(); entry.size=(uint)Marshal.SizeOf(typeof(Entry));
                bool available=Process32FirstW(snapshot,ref entry);
                while(available) { if(result.Count>=4096)throw new InvalidOperationException("Process snapshot exceeds bound."); result.Add(entry); available=Process32NextW(snapshot,ref entry); }
                int error=Marshal.GetLastWin32Error(); if(error!=18)throw new Win32Exception(error);
                return result;
            } finally { CloseHandle(snapshot); }
        }
        object[] Dialogs() {
            var result=new List<object>(); var clock=Stopwatch.StartNew();
            WindowCallback windows=delegate(IntPtr window,IntPtr context) {
                if(clock.ElapsedMilliseconds>=500 || result.Count>=4)return false;
                uint process; GetWindowThreadProcessId(window,out process); if(process!=(uint)rootPid)return true;
                var type=new StringBuilder(128); GetClassNameW(window,type,type.Capacity); if(type.ToString()!="#32770")return true;
                var title=new StringBuilder(512); GetWindowTextW(window,title,title.Capacity);
                var texts=new List<string>();
                WindowCallback children=delegate(IntPtr child,IntPtr ignored) {
                    if(clock.ElapsedMilliseconds>=500 || texts.Count>=8)return false;
                    uint childProcess; GetWindowThreadProcessId(child,out childProcess); if(childProcess!=(uint)rootPid)return true;
                    var childType=new StringBuilder(128); GetClassNameW(child,childType,childType.Capacity); if(childType.ToString()!="Static")return true;
                    var text=new StringBuilder(1024); UIntPtr length;
                    uint budget=(uint)Math.Max(1,Math.Min(50,500-clock.ElapsedMilliseconds));
                    if(SendMessageTimeoutW(child,13,new UIntPtr(1024),text,2,budget,out length)!=IntPtr.Zero && text.Length>0)texts.Add(text.ToString());
                    return true;
                };
                EnumChildWindows(window,children,IntPtr.Zero);
                result.Add(new { title=title.ToString(),texts=texts.ToArray() }); return true;
            };
            EnumWindows(windows,IntPtr.Zero); return result.ToArray();
        }
        public object Capture() {
            var entries=ProcessEntries(); var unavailable=new HashSet<int>(); bool truncated=false,changed=true;
            foreach(var entry in entries)if(entry.pid==(uint)rootPid)held[rootPid].parent=(int)entry.parent;
            while(changed) {
                changed=false;
                foreach(var entry in entries) {
                    int id=(int)entry.pid,parentId=(int)entry.parent;
                    if(id<=0 || held.ContainsKey(id) || unavailable.Contains(id) || !held.ContainsKey(parentId))continue;
                    if(held.Count>=32){truncated=true;break;}
                    Held candidate=null;
                    try {
                        candidate=new Held(OpenProcess(Access,false,id),id,parentId,null,0); var parent=held[parentId];
                        ulong parentExit=parent.ExitTime();
                        if(candidate.created<parent.created || (parentExit!=0 && candidate.created>parentExit)) { unavailable.Add(id); continue; }
                        held.Add(id,candidate); candidate=null; changed=true;
                    } catch { unavailable.Add(id); }
                    finally { if(candidate!=null)candidate.Dispose(); }
                }
            }
            var records=new List<object>();
            foreach(var process in held.Values)records.Add(process.Observe());
            return new { processes=records.ToArray(),unavailableProcessIds=new List<int>(unavailable).ToArray(),truncated,guardianDialogs=Dialogs() };
        }
        public void Dispose(){foreach(var process in held.Values)process.Dispose();held.Clear();}
    }
}
