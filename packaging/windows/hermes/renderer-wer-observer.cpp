// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only WER observer. Never claims an exception or changes the target.
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace {
constexpr size_t kOutputBytes = 8192;
struct Config {
  char source[41]{}, nonce[13]{}, chrome_sha[65]{};
  uint64_t chrome_bytes = 0, volume = 0;
  uint8_t file_id[16]{};
};
int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
bool exact_hex(const char* p, size_t n) {
  for (size_t i = 0; i < n; ++i) if (hex_digit(p[i]) < 0) return false;
  return true;
}
bool number(const char* p, size_t n, unsigned radix, uint64_t* out) {
  if (!n || n > 20) return false;
  uint64_t value = 0;
  for (size_t i = 0; i < n; ++i) {
    int d = hex_digit(p[i]);
    if (d < 0 || static_cast<unsigned>(d) >= radix || value > (UINT64_MAX - d) / radix) return false;
    value = value * radix + d;
  }
  *out = value;
  return true;
}
bool parse_config(const char* data, size_t bytes, Config* out) {
  if (!bytes || bytes > 512 || data[bytes - 1] != '\n') return false;
  const char* lines[7]{}; size_t lengths[7]{}; size_t start = 0, count = 0;
  for (size_t i = 0; i < bytes; ++i) {
    if (data[i] == '\n') {
      if (count == 7 || i == start) return false;
      lines[count] = data + start; lengths[count++] = i - start; start = i + 1;
    } else if (data[i] < 0x20 || data[i] > 0x7e) return false;
  }
  constexpr char header[] = "NEMOCLAW_RENDERER_WER_V1";
  if (count != 7 || lengths[0] != sizeof(header)-1 || std::memcmp(lines[0], header, sizeof(header)-1)) return false;
  if (lengths[1] != 40 || lengths[2] != 12 || lengths[4] != 64 || lengths[6] != 32 ||
      !exact_hex(lines[1], 40) || !exact_hex(lines[2], 12) || !exact_hex(lines[4], 64) || !exact_hex(lines[6], 32)) return false;
  if (!number(lines[3], lengths[3], 10, &out->chrome_bytes) || !out->chrome_bytes || out->chrome_bytes > 16*1024*1024) return false;
  if (lengths[5] < 3 || lengths[5] > 18 || lines[5][0] != '0' || lines[5][1] != 'x' || !number(lines[5]+2, lengths[5]-2, 16, &out->volume)) return false;
  std::memcpy(out->source, lines[1], 40); std::memcpy(out->nonce, lines[2], 12); std::memcpy(out->chrome_sha, lines[4], 64);
  for (size_t i = 0; i < 16; ++i) out->file_id[i] = static_cast<uint8_t>(hex_digit(lines[6][i*2])*16+hex_digit(lines[6][i*2+1]));
  return true;
}
struct Buffer {
  char data[kOutputBytes]{}; size_t used = 0; bool valid = true;
  void ch(char c) { if (used == sizeof(data)) valid = false; else data[used++] = c; }
  void text(const char* p) { while (*p) ch(*p++); }
  void uint(uint64_t n) { char digits[20]; size_t i = 0; do { digits[i++] = static_cast<char>('0'+n%10); n /= 10; } while(n); while(i) ch(digits[--i]); }
  void hex(uint64_t n) { constexpr char digits[] = "0123456789abcdef"; char reversed[16]; size_t i = 0; text("\"0x"); do { reversed[i++] = digits[n&15]; n >>= 4; } while(n); while(i) ch(reversed[--i]); ch('"'); }
  void boolean(bool value) { text(value ? "true" : "false"); }
  void quote(const char* p) { ch('"'); for (;*p;++p) { if (*p == '"' || *p == '\\') ch('\\'); ch(*p); } ch('"'); }
};
}  // namespace

#ifdef _WIN32
#include <Windows.h>
#include <werapi.h>
#include <psapi.h>
#ifndef _M_X64
#error This WER observer must be compiled for AMD64.
#endif
static_assert(sizeof(PROCESS_MACHINE_INFORMATION) == 8);
static_assert(offsetof(PROCESS_MACHINE_INFORMATION, MachineAttributes) == 4);
static_assert(sizeof(CONTEXT) == 1232 && offsetof(CONTEXT, ContextFlags) == 48);
static_assert(offsetof(CONTEXT, Rax) == 120 && offsetof(CONTEXT, Rsp) == 152 && offsetof(CONTEXT, Rip) == 248);
static_assert(offsetof(WER_RUNTIME_EXCEPTION_INFORMATION, context) == 176);
static_assert(offsetof(WER_RUNTIME_EXCEPTION_INFORMATION, bIsFatal) == 1416);
namespace {
struct State {
  Config config{};
  wchar_t root[MAX_PATH]{}, reports[MAX_PATH]{}, chrome[MAX_PATH]{}, host_image[MAX_PATH]{};
  char root_nonce[13]{};
  DWORD host_pid = 0; uint64_t host_created = 0;
  bool config_valid = false, load_record_written = false;
  LONG calls = 0, unselected_calls = 0;
} g;
uint64_t filetime(const FILETIME& t) { return (uint64_t{t.dwHighDateTime} << 32) | t.dwLowDateTime; }
size_t length(const wchar_t* p, size_t maximum) { size_t i=0; while(i<maximum && p[i]) ++i; return i; }
wchar_t lower(wchar_t c) { return c >= L'A' && c <= L'Z' ? c+32 : c; }
bool equal(const wchar_t* a, const wchar_t* b) { for (;*a && *b;++a,++b) if(lower(*a)!=lower(*b)) return false; return *a==*b; }
bool append(wchar_t* target, size_t cap, const wchar_t* value) {
  size_t n=length(target,cap), m=length(value,cap);
  if(n==cap || m>=cap-n) return false;
  for(size_t i=0;i<=m;++i) target[n+i]=value[i]; return true;
}
bool append_number(wchar_t* target, uint64_t n) {
  wchar_t reversed[20], normal[21]{}; size_t i=0,j=0;
  do { reversed[i++]=static_cast<wchar_t>(L'0'+n%10); n/=10; }while(n);
  while(i) normal[j++]=reversed[--i]; return append(target,MAX_PATH,normal);
}
void wide(Buffer& b,const wchar_t* p) {
  constexpr char h[]="0123456789abcdef"; b.ch('"');
  for(size_t i=0;p[i] && i<MAX_PATH;++i) {
    unsigned c=static_cast<unsigned>(p[i]);
    if(c>=0x20 && c<0x7f) { if(c=='"'||c=='\\') b.ch('\\'); b.ch(static_cast<char>(c)); }
    else { b.text("\\u"); for(int j=12;j>=0;j-=4) b.ch(h[(c>>j)&15]); }
  } b.ch('"');
}
bool current_generation(HANDLE process,uint64_t* created) {
  FILETIME c{},e{},k{},u{}; if(!GetProcessTimes(process,&c,&e,&k,&u)) return false; *created=filetime(c); return *created!=0;
}
// /EHa keeps these owned host-file guards active during the outer SEH recovery.
// Supplied WER process/thread handles are never wrapped or closed.
struct OwnedFile {
  HANDLE value = INVALID_HANDLE_VALUE;
  bool attempted = false, closed = true;
  explicit OwnedFile(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle), closed(handle == INVALID_HANDLE_VALUE) {}
  OwnedFile(const OwnedFile&) = delete;
  OwnedFile& operator=(const OwnedFile&) = delete;
  bool close() {
    if (!attempted && value != INVALID_HANDLE_VALUE) {
      attempted = true; closed = CloseHandle(value) != FALSE;
      if (closed) value = INVALID_HANDLE_VALUE;
    }
    return closed;
  }
  ~OwnedFile() { close(); }
};
bool write_record(const wchar_t* filename,Buffer& b) {
  if(!b.valid || b.used>=kOutputBytes) return false; b.ch('\n');
  wchar_t path[MAX_PATH]{}; if(!append(path,MAX_PATH,g.reports)||!append(path,MAX_PATH,L"\\")||!append(path,MAX_PATH,filename)) return false;
  OwnedFile file(CreateFileW(path,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
  if(file.value==INVALID_HANDLE_VALUE) return false;
  DWORD wrote=0; bool ok=WriteFile(file.value,b.data,static_cast<DWORD>(b.used),&wrote,nullptr)!=FALSE && wrote==b.used;
  return file.close() && ok;
}
bool self_root(HMODULE module) {
  wchar_t self[MAX_PATH]{}; DWORD size=GetModuleFileNameW(module,self,MAX_PATH); if(!size || size>=MAX_PATH) return false;
  constexpr wchar_t prefix[]=L"C:\\NemoClawRendererWer-";
  constexpr wchar_t suffix[]=L"\\chrome-win64\\chrome_wer.dll";
  constexpr size_t n=sizeof(prefix)/sizeof(wchar_t)-1;
  if(size!=n+12+sizeof(suffix)/sizeof(wchar_t)-1) return false;
  for(size_t i=0;i<n;++i) if(lower(self[i])!=lower(prefix[i])) return false;
  for(size_t i=0;i<12;++i) { if(self[n+i]>127 || hex_digit(static_cast<char>(self[n+i]))<0) return false; g.root_nonce[i]=static_cast<char>(self[n+i]); }
  if(!equal(self+n+12,suffix)) return false;
  for(size_t i=0;i<n+12;++i) g.root[i]=self[i];
  return append(g.reports,MAX_PATH,g.root)&&append(g.reports,MAX_PATH,L"\\reports")&&append(g.chrome,MAX_PATH,g.root)&&append(g.chrome,MAX_PATH,L"\\chrome-win64\\chrome.exe");
}
bool read_config() {
  wchar_t path[MAX_PATH]{}; if(!append(path,MAX_PATH,g.root)||!append(path,MAX_PATH,L"\\renderer-wer-observer.txt")) return false;
  OwnedFile f(CreateFileW(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if(f.value==INVALID_HANDLE_VALUE) return false;
  FILE_ATTRIBUTE_TAG_INFO tag{}; LARGE_INTEGER size{}; char data[513]{}; DWORD read=0;
  bool ok=GetFileInformationByHandleEx(f.value,FileAttributeTagInfo,&tag,sizeof(tag)) && !(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)) && GetFileSizeEx(f.value,&size) && size.QuadPart>0 && size.QuadPart<=512 && ReadFile(f.value,data,static_cast<DWORD>(size.QuadPart),&read,nullptr) && read==static_cast<DWORD>(size.QuadPart) && parse_config(data,read,&g.config) && !std::memcmp(g.config.nonce,g.root_nonce,12);
  return f.close() && ok;
}
void initialize(HMODULE module) {
  if(!self_root(module)) return;
  g.host_pid=GetCurrentProcessId(); bool generation=current_generation(GetCurrentProcess(),&g.host_created);
  DWORD size=MAX_PATH; bool image=QueryFullProcessImageNameW(GetCurrentProcess(),0,g.host_image,&size)!=FALSE && size<MAX_PATH;
  g.config_valid=read_config();
  Buffer b; b.text("{\"schemaVersion\":1,\"classification\":\"renderer-wer-host-load\",\"nonce\":");b.quote(g.root_nonce);
  b.text(",\"sourceRevision\":");b.quote(g.config.source);b.text(",\"hostPid\":");b.uint(g.host_pid);b.text(",\"hostCreationFiletime\":\"");b.uint(g.host_created);b.text("\",\"hostImage\":");wide(b,g.host_image);
  b.text(",\"hostIdentityComplete\":");b.boolean(generation&&image);b.text(",\"configValid\":");b.boolean(g.config_valid);b.text(",\"bindingAvailable\":");b.boolean(g.config_valid);b.text(",\"tick\":");b.uint(GetTickCount64());b.text(",\"callbackExecuted\":false,\"hostExitProved\":false,\"originalChromeWerCode409NowNonclaimed\":true}");
  wchar_t name[MAX_PATH]=L"wer-load-"; if(!append_number(name,g.host_pid)||!append(name,MAX_PATH,L"-")||!append_number(name,g.host_created)||!append(name,MAX_PATH,L".json")) return;
  g.load_record_written=write_record(name,b)&&generation&&image;
}
struct FileIdentity { FILE_ID_INFO id{}; uint64_t bytes=0; OwnedFile file{}; DWORD error=0; };
bool open_identity(const wchar_t* path,FileIdentity& out) {
  out.file.value=CreateFileW(path,FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(out.file.value==INVALID_HANDLE_VALUE) { out.error=GetLastError(); return false; }
  out.file.closed=false;
  FILE_ATTRIBUTE_TAG_INFO tag{}; FILE_STANDARD_INFO size{};
  bool ok=GetFileInformationByHandleEx(out.file.value,FileAttributeTagInfo,&tag,sizeof(tag)) && !(tag.FileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)) && GetFileInformationByHandleEx(out.file.value,FileIdInfo,&out.id,sizeof(out.id)) && GetFileInformationByHandleEx(out.file.value,FileStandardInfo,&size,sizeof(size)) && !size.Directory && !size.DeletePending && size.EndOfFile.QuadPart>0;
  if(!ok) { out.error=GetLastError(); return false; } out.bytes=static_cast<uint64_t>(size.EndOfFile.QuadPart); return true;
}
bool configured(const FileIdentity& x) { return x.bytes==g.config.chrome_bytes && x.id.VolumeSerialNumber==g.config.volume && !std::memcmp(x.id.FileId.Identifier,g.config.file_id,16); }
bool renderer_command(HANDLE process,LONG* status) {
  struct Unicode { USHORT length, maximum; PWSTR buffer; };
  using Query=LONG(NTAPI*)(HANDLE,ULONG,PVOID,ULONG,PULONG);
  auto query=reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtQueryInformationProcess"));
  if(!query) { *status=static_cast<LONG>(0xc0000002); return false; }
  alignas(void*) char storage[8192]{}; ULONG needed=0; *status=query(process,60,storage,sizeof(storage),&needed); if(*status<0) return false;
  auto* value=reinterpret_cast<Unicode*>(storage); uintptr_t a=reinterpret_cast<uintptr_t>(value->buffer),begin=reinterpret_cast<uintptr_t>(storage),end=begin+sizeof(storage);
  if(value->length%2 || a<begin || a>end || value->length>end-a) return false;
  const wchar_t* p=value->buffer; size_t length=value->length/2; unsigned found=0;
  for(size_t i=0;i<length;) {
    while(i<length && (p[i]==L' '||p[i]==L'\t')) ++i;
    wchar_t token[64]{};size_t n=0;bool quoted=false,too_long=false;
    while(i<length && (quoted || (p[i]!=L' '&&p[i]!=L'\t'))) { wchar_t ch=p[i++]; if(ch==L'"'){quoted=!quoted;continue;} if(n<63) token[n++]=ch;else too_long=true; }
    if(quoted) return false;
    if(!too_long && n>=7 && !std::memcmp(token,L"--type=",7*sizeof(wchar_t))) { if(!equal(token,L"--type=renderer")) return false; ++found; }
  } return found==1;
}
struct Module { const wchar_t* wide_name; const char* name; uintptr_t base=0; DWORD size=0; };
void location(Buffer& b,Module* modules,size_t count,uint64_t address) {
  for(size_t i=0;i<count;++i) if(modules[i].base && address>=modules[i].base && address-modules[i].base<modules[i].size) {
    b.text("{\"module\":");b.quote(modules[i].name);b.text(",\"base\":");b.hex(modules[i].base);b.text(",\"rva\":");b.hex(address-modules[i].base);b.ch('}');return;
  } b.text("null");
}
bool mapped(Module* modules,size_t count,uint64_t address) { for(size_t i=0;i<count;++i)if(modules[i].base && address>=modules[i].base && address-modules[i].base<modules[i].size)return true;return false; }
void observe(const WER_RUNTIME_EXCEPTION_INFORMATION& info) {
  if(!g.load_record_written || !g.config_valid) return;
  const bool selected = info.bIsFatal && info.exceptionRecord.ExceptionCode==0xc0000008;
  if(selected ? InterlockedIncrement(&g.calls)>2 : InterlockedIncrement(&g.unselected_calls)>1) return;
  uint64_t started=GetTickCount64(),created=0; DWORD pid=0,tid=0;DWORD error=0;const char* stage="identity";
  bool identity=false,context=false; wchar_t image[MAX_PATH]{};DWORD chars=MAX_PATH;LONG command_status=0;
  FileIdentity actual{},expected{};PROCESS_MACHINE_INFORMATION machine{};bool machine_ok=false;
  do {
    pid=GetProcessId(info.hProcess); if(!pid) { error=GetLastError();break; }
    tid=GetThreadId(info.hThread); if(!tid) { error=GetLastError();break; }
    DWORD thread_pid=GetProcessIdOfThread(info.hThread);
    if(!thread_pid) { error=GetLastError();break; }
    if(thread_pid!=pid) { stage="thread-process-mismatch";break; }
    if(!current_generation(info.hProcess,&created)) { error=GetLastError();break; }
    if(!QueryFullProcessImageNameW(info.hProcess,0,image,&chars)) { error=GetLastError();break; }
    if(chars>=MAX_PATH || !equal(image,g.chrome)) { stage="image-path-mismatch";break; }
    stage="image-file-identity";
    if(!open_identity(image,actual)||!open_identity(g.chrome,expected)||!configured(actual)||!configured(expected)) { error=actual.error?actual.error:expected.error;break; }
    stage="renderer-command"; if(!renderer_command(info.hProcess,&command_status)) break;
    identity=true;
    if(!selected) { stage="unsupported-exception-not-claimed";break; }
    stage="machine-context";
    machine_ok=GetProcessInformation(info.hProcess,ProcessMachineTypeInfo,&machine,sizeof(machine))!=FALSE;
    if(!machine_ok) { error=GetLastError();break; }
    if(machine.ProcessMachine!=IMAGE_FILE_MACHINE_AMD64 || (info.context.ContextFlags&(CONTEXT_CONTROL|CONTEXT_INTEGER))!=(CONTEXT_CONTROL|CONTEXT_INTEGER)) break;
    context=true;stage="complete";
  }while(false);
  bool files_closed=actual.file.close();files_closed=expected.file.close()&&files_closed;
  Buffer b;b.text("{\"schemaVersion\":1,\"classification\":\"renderer-wer-exception-observation\",\"diagnosticOnly\":true,\"ownershipClaimed\":false,\"callbackReturn\":\"S_OK\",\"sourceRevision\":");b.quote(g.config.source);
  b.text(",\"nonce\":");b.quote(g.root_nonce);b.text(",\"hostPid\":");b.uint(g.host_pid);b.text(",\"hostCreationFiletime\":\"");b.uint(g.host_created);b.text("\",\"pid\":");b.uint(pid);b.text(",\"tid\":");b.uint(tid);b.text(",\"creationFiletime\":\"");b.uint(created);b.text("\",\"stage\":");b.quote(stage);b.text(",\"win32Error\":");b.uint(error);b.text(",\"commandQueryStatus\":");b.hex(static_cast<uint32_t>(command_status));
  b.text(",\"identityMatched\":");b.boolean(identity);b.text(",\"fileHandlesClosed\":");b.boolean(files_closed);b.text(",\"expectedChromeSha256\":");b.quote(g.config.chrome_sha);b.text(",\"expectedFileId\":\"");constexpr char h[]="0123456789abcdef";for(uint8_t byte:g.config.file_id){b.ch(h[byte>>4]);b.ch(h[byte&15]);}b.text("\",\"expectedVolume\":");b.hex(g.config.volume);
  b.text(",\"imageFileIdentity\":{\"bytes\":");b.uint(actual.bytes);b.text(",\"volumeSerialHex\":");b.hex(actual.id.VolumeSerialNumber);b.text(",\"fileIdHex\":\"");for(uint8_t byte:actual.id.FileId.Identifier){b.ch(h[byte>>4]);b.ch(h[byte&15]);}b.text("\"}");
  b.text(",\"fatal\":");b.boolean(info.bIsFatal!=FALSE);b.text(",\"selectedInvalidHandle\":");b.boolean(selected);b.text(",\"originalChromeWerCode409NowNonclaimed\":");b.boolean(info.bIsFatal && info.exceptionRecord.ExceptionCode==0xc0000409);b.text(",\"code\":");b.hex(info.exceptionRecord.ExceptionCode);b.text(",\"exceptionFlags\":");b.hex(info.exceptionRecord.ExceptionFlags);b.text(",\"exceptionAddress\":");b.hex(reinterpret_cast<uintptr_t>(info.exceptionRecord.ExceptionAddress));b.text(",\"machineQuerySucceeded\":");b.boolean(machine_ok);b.text(",\"processMachine\":");b.hex(machine.ProcessMachine);b.text(",\"contextAccepted\":");b.boolean(context);b.text(",\"contextFlags\":");b.hex(info.context.ContextFlags);
  if(context) {
    const uint64_t registers[]={info.context.Rax,info.context.Rcx,info.context.Rdx,info.context.Rbx,info.context.Rsp,info.context.Rbp,info.context.Rsi,info.context.Rdi,info.context.R8,info.context.R9,info.context.R10,info.context.R11,info.context.R12,info.context.R13,info.context.R14,info.context.R15,info.context.Rip};
    const char* names[]={"Rax","Rcx","Rdx","Rbx","Rsp","Rbp","Rsi","Rdi","R8","R9","R10","R11","R12","R13","R14","R15","Rip"};
    b.text(",\"registers\":{");for(size_t i=0;i<17;++i){if(i)b.ch(',');b.quote(names[i]);b.ch(':');b.hex(registers[i]);}b.ch('}');
    Module modules[]={{L"chrome.exe","chrome.exe"},{L"chrome.dll","chrome.dll"},{L"chrome_elf.dll","chrome_elf.dll"},{L"ntdll.dll","ntdll.dll"},{L"kernel32.dll","kernel32.dll"},{L"kernelbase.dll","kernelbase.dll"},{L"xtajit64.dll","xtajit64.dll"},{L"xtajit64se.dll","xtajit64se.dll"}};
    HMODULE handles[128]{};DWORD needed=0;bool enumeration=K32EnumProcessModulesEx(info.hProcess,handles,sizeof(handles),&needed,LIST_MODULES_ALL)!=FALSE;DWORD enumeration_error=enumeration?0:GetLastError();
    if(enumeration)for(size_t i=0;i<needed/sizeof(HMODULE)&&i<128;++i){wchar_t name[MAX_PATH]{};if(!K32GetModuleBaseNameW(info.hProcess,handles[i],name,MAX_PATH))continue;for(auto& module:modules)if(equal(name,module.wide_name)){MODULEINFO value{};if(K32GetModuleInformation(info.hProcess,handles[i],&value,sizeof(value))){module.base=reinterpret_cast<uintptr_t>(value.lpBaseOfDll);module.size=value.SizeOfImage;}}}
    b.text(",\"moduleEnumeration\":{\"succeeded\":");b.boolean(enumeration);b.text(",\"win32Error\":");b.uint(enumeration_error);b.text(",\"truncated\":");b.boolean(needed>sizeof(handles));b.text(",\"missingFixedModules\":[");bool comma=false;for(const auto& module:modules)if(!module.base){if(comma)b.ch(',');b.quote(module.name);comma=true;}b.text("]},\"instructionLocation\":");location(b,modules,8,info.context.Rip);
    uint64_t stack[128]{};SIZE_T read=0;bool ok=ReadProcessMemory(info.hProcess,reinterpret_cast<void*>(info.context.Rsp),stack,sizeof(stack),&read)!=FALSE;DWORD read_error=ok?0:GetLastError();if(read>sizeof(stack)){read=0;ok=false;read_error=ERROR_INVALID_DATA;}
    b.text(",\"stack\":{\"unwound\":false,\"requestedBytes\":1024,\"readBytes\":");b.uint(read);b.text(",\"readSucceeded\":");b.boolean(ok);b.text(",\"win32Error\":");b.uint(read_error);b.text(",\"candidates\":[");size_t kept=0;for(size_t i=0;i<read/8&&kept<16;++i)if(mapped(modules,8,stack[i])){if(kept++)b.ch(',');b.text("{\"stackOffsetBytes\":");b.uint(i*8);b.text(",\"address\":");b.hex(stack[i]);b.text(",\"location\":");location(b,modules,8,stack[i]);b.ch('}');}b.text("]}");
  }
  b.text(",\"startedTick\":");b.uint(started);b.text(",\"completedTick\":");b.uint(GetTickCount64());b.text(",\"targetMutated\":false,\"providedHandlesClosed\":false,\"hostExitProved\":false}");
  wchar_t name[MAX_PATH]=L"renderer-";if(append_number(name,pid)&&append(name,MAX_PATH,L"-")&&append_number(name,tid)&&append(name,MAX_PATH,L"-")&&append_number(name,created)&&append(name,MAX_PATH,L".json"))write_record(name,b);
}
void observer_failure(const char* stage, DWORD code) {
  if(!g.root[0] || !g.host_pid || !g.host_created) return;
  Buffer b; b.text("{\"schemaVersion\":1,\"classification\":\"renderer-wer-observer-failure\",\"sourceRevision\":");b.quote(g.config.source);b.text(",\"nonce\":");b.quote(g.root_nonce);b.text(",\"bindingAvailable\":");b.boolean(g.config_valid);b.text(",\"hostPid\":");b.uint(g.host_pid);
  b.text(",\"hostCreationFiletime\":\"");b.uint(g.host_created);b.text("\",\"stage\":");b.quote(stage);b.text(",\"observerException\":");b.hex(code);
  b.text(",\"ownershipClaimed\":false,\"hostExitProved\":false,\"ownedFileClosureRequiresHostExitVerification\":true}");
  wchar_t name[MAX_PATH]=L"observer-failure-";if(append_number(name,g.host_pid)&&append(name,MAX_PATH,L"-")&&append_number(name,g.host_created)&&append(name,MAX_PATH,L".json"))write_record(name,b);
}
void report_failure_safely(const char* stage,DWORD code) {
  __try { observer_failure(stage,code); } __except(EXCEPTION_EXECUTE_HANDLER) { }
}
}  // namespace
extern "C" {
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,LPVOID) {
  if(reason==DLL_PROCESS_ATTACH) {
    __try { initialize(module); }
    __except(EXCEPTION_EXECUTE_HANDLER) { g.load_record_written=false;report_failure_safely("initialization",GetExceptionCode()); }
  }
  return TRUE;
}
__declspec(dllexport) HRESULT WINAPI OutOfProcessExceptionEventCallback(PVOID,const PWER_RUNTIME_EXCEPTION_INFORMATION info,BOOL* ownership,PWSTR,PDWORD,PDWORD) {
  __try {
    if(ownership)*ownership=FALSE;
    if(info && info->dwSize>=offsetof(WER_RUNTIME_EXCEPTION_INFORMATION,bIsFatal)+sizeof(BOOL))observe(*info);
  } __except(EXCEPTION_EXECUTE_HANDLER) {
    report_failure_safely("callback",GetExceptionCode());
  }
  return S_OK;
}
// Ownership is never claimed, so WER should not call these outputs-producing paths.
__declspec(dllexport) HRESULT WINAPI OutOfProcessExceptionEventSignatureCallback(PVOID,const PWER_RUNTIME_EXCEPTION_INFORMATION,DWORD,PWSTR,PDWORD,PWSTR,PDWORD) { return E_FAIL; }
__declspec(dllexport) HRESULT WINAPI OutOfProcessExceptionEventDebuggerLaunchCallback(PVOID,const PWER_RUNTIME_EXCEPTION_INFORMATION,PBOOL,PWSTR,PDWORD,PBOOL) { return E_FAIL; }
}
#endif  // _WIN32
