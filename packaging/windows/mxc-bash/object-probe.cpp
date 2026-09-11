// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// CI-only raw NT object probe. Never linked to or launched through the compatibility shim.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <winternl.h>
#include <securityappcontainer.h>
#include <sddl.h>
#include <array>
#include <cstdint>
#include <cstring>
#include <algorithm>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

struct Handle {
  HANDLE value=nullptr;
  Handle()=default;
  Handle(const Handle&)=delete;
  Handle& operator=(const Handle&)=delete;
  ~Handle(){if(value && value!=INVALID_HANDLE_VALUE) CloseHandle(value);}
};
struct View {void* value=nullptr;~View(){if(value)UnmapViewOfFile(value);}};
void require(bool value,const char* why){if(!value)throw std::runtime_error(why);}
std::string utf8(const std::wstring& text){
  if(text.empty())return {};
  int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),nullptr,0,nullptr,nullptr);
  require(count>0,"utf8-size");std::string result(static_cast<size_t>(count),'\0');
  require(WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,text.data(),static_cast<int>(text.size()),result.data(),count,nullptr,nullptr)==count,"utf8-copy");return result;
}
std::string quote(const std::string& text){std::string result="\"";for(unsigned char c:text){if(c=='"'||c=='\\')result+='\\';require(c>=32,"json-control");result+=static_cast<char>(c);}return result+'"';}
std::string status(NTSTATUS value){std::ostringstream out;out<<"0x"<<std::hex<<std::setfill('0')<<std::setw(8)<<static_cast<std::uint32_t>(value);return quote(out.str());}
bool lowerHex(const std::wstring& value,size_t length){if(value.size()!=length)return false;for(wchar_t c:value)if(!((c>=L'0'&&c<=L'9')||(c>=L'a'&&c<=L'f')))return false;return true;}
struct Name {
  UNICODE_STRING unicode{};OBJECT_ATTRIBUTES attributes{};
  Name(std::wstring& name,HANDLE parent=nullptr,PVOID security=nullptr,ULONG flags=0){
    require(name.size()<16380,"object-name-bound");unicode.Length=static_cast<USHORT>(name.size()*sizeof(wchar_t));unicode.MaximumLength=unicode.Length;unicode.Buffer=name.data();
    attributes.Length=sizeof(attributes);attributes.ObjectName=&unicode;attributes.RootDirectory=parent;attributes.SecurityDescriptor=security;attributes.Attributes=flags;
  }
};
using OpenDirectory=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using NtCreateDirectoryFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using NtCreateEventFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,ULONG,BOOLEAN);
using NtOpenEventFunction=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using CreateSection=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PLARGE_INTEGER,ULONG,ULONG,HANDLE);
using OpenSection=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
struct Api {
  HMODULE nt=GetModuleHandleW(L"ntdll.dll");
  OpenDirectory openDirectory;NtCreateDirectoryFunction createDirectory;NtCreateEventFunction createEvent;NtOpenEventFunction openEvent;CreateSection createSection;OpenSection openSection;
  template<typename T> T load(const char* name){FARPROC value=GetProcAddress(nt,name);T function=nullptr;static_assert(sizeof(value)==sizeof(function));std::memcpy(&function,&value,sizeof(function));return function;}
  Api(){
    require(nt!=nullptr,"ntdll-missing");
    openDirectory=load<OpenDirectory>("NtOpenDirectoryObject");
    createDirectory=load<NtCreateDirectoryFunction>("NtCreateDirectoryObject");
    createEvent=load<NtCreateEventFunction>("NtCreateEvent");openEvent=load<NtOpenEventFunction>("NtOpenEvent");
    createSection=load<CreateSection>("NtCreateSection");openSection=load<OpenSection>("NtOpenSection");
    require(openDirectory&&createDirectory&&createEvent&&openEvent&&createSection&&openSection,"ntdll-export-missing");
  }
};
std::wstring resolve_private_root(const std::wstring& raw,const std::wstring& sid,unsigned long session){
  const std::wstring relative=L"AppContainerNamedObjects\\"+sid;
  const std::wstring resolved=L"\\Sessions\\"+std::to_wstring(session)+L"\\"+relative;
  require(raw==relative,"private-root-token-binding");
  return resolved;
}
void line(const std::string& text);
struct Identity {std::wstring root,rawRoot,sid;DWORD session=0;};
Identity identity(Api& api){
  require(!GetModuleHandleW(L"NemoClawMsysCompat-arm64.dll")&&!GetModuleHandleW(L"NemoClawMsysCompat-x64.dll"),"raw-probe-was-shimmed");
  Handle token;require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value)!=0,"token-open");DWORD needed=0,app=0;
  require(GetTokenInformation(token.value,TokenIsAppContainer,&app,sizeof(app),&needed)!=0&&app==1,"not-appcontainer");
  GetTokenInformation(token.value,TokenAppContainerSid,nullptr,0,&needed);require(needed>0&&needed<4096,"sid-size");std::vector<unsigned char> data(needed);
  require(GetTokenInformation(token.value,TokenAppContainerSid,data.data(),needed,&needed)!=0,"sid-query");auto info=reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(data.data());
  LPWSTR text=nullptr;require(ConvertSidToStringSidW(info->TokenAppContainer,&text)!=0,"sid-string");Identity result;result.sid=text;LocalFree(text);
  std::array<wchar_t,4096> buffer{};ULONG count=0;
  require(GetAppContainerNamedObjectPath(token.value,nullptr,static_cast<ULONG>(buffer.size()),buffer.data(),&count)!=0,"private-root-query");
  require(wcsnlen(buffer.data(),buffer.size())<buffer.size(),"private-root-bound");result.rawRoot=buffer.data();
  require(GetTokenInformation(token.value,TokenSessionId,&result.session,sizeof(result.session),&needed)!=0,"token-session-query");
  DWORD processSession=0;require(ProcessIdToSessionId(GetCurrentProcessId(),&processSession)!=0&&processSession==result.session,"process-token-session-match");
  line("{\"kind\":\"namespace-root-input\",\"rawProbeUnshimmed\":true,\"sid\":"+quote(utf8(result.sid))+",\"session\":"+std::to_string(result.session)+",\"rawApiPath\":"+quote(utf8(result.rawRoot))+"}");
  result.root=resolve_private_root(result.rawRoot,result.sid,result.session);
  Handle root;Name object(result.root);NTSTATUS opened=api.openDirectory(&root.value,0x1,&object.attributes);
  line("{\"kind\":\"namespace-root-validation\",\"rawProbeUnshimmed\":true,\"resolvedNtPath\":"+quote(utf8(result.root))+",\"directoryQueryStatus\":"+status(opened)+"}");
  require(opened==0,"private-root-original-open");return result;
}
std::wstring globalLeaf(const std::wstring& key){return L"NemoClawMsys-G-msys-2.0S5-"+key;}
std::wstring sessionLeaf(DWORD session,const std::wstring& key){return L"NemoClawMsys-S"+std::to_wstring(session)+L"-msys-2.0S5-"+key;}
std::wstring absolute(std::wstring root,const std::wstring& leaf){return root+L"\\"+leaf;}
NTSTATUS openDir(Api& api,std::wstring name,Handle& result){Name object(name);return api.openDirectory(&result.value,0x2000f,&object.attributes);}
bool missing(NTSTATUS value){auto code=static_cast<std::uint32_t>(value);return code==0xc0000034||code==0xc000003a;}
std::string identityFields(const Identity& id){return "\"pid\":"+std::to_string(GetCurrentProcessId())+",\"session\":"+std::to_string(id.session)+",\"sid\":"+quote(utf8(id.sid))+",\"rawApiPath\":"+quote(utf8(id.rawRoot))+",\"privateRoot\":"+quote(utf8(id.root))+",\"rawProbeUnshimmed\":true";}
void line(const std::string& text){std::cout<<text<<'\n';std::cout.flush();require(std::cout.good(),"stdout-write");}
std::string readLine(){std::string result;char c;while(std::cin.get(c)){if(c=='\n')return result;require(c>=32&&c<=126&&result.size()<1024,"command-bound");result+=c;}throw std::runtime_error("command-eof");}
std::string jobProof(DWORD workerPid,DWORD executorPid){
  BOOL member=FALSE;require(IsProcessInJob(GetCurrentProcess(),nullptr,&member)!=0&&member,"not-in-job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};require(QueryInformationJobObject(nullptr,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr)!=0,"job-limits-query");
  DWORD flags=limits.BasicLimitInformation.LimitFlags;
  require((flags&JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)!=0&&!(flags&(JOB_OBJECT_LIMIT_BREAKAWAY_OK|JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)),"job-flags");
  std::vector<unsigned char> storage(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST)+256*sizeof(ULONG_PTR));auto members=reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(storage.data());
  require(QueryInformationJobObject(nullptr,JobObjectBasicProcessIdList,members,static_cast<DWORD>(storage.size()),nullptr)!=0&&members->NumberOfProcessIdsInList<=256,"job-members-query");
  bool hasSelf=false,hasWorker=false,hasExecutor=false;std::ostringstream ids;
  for(DWORD i=0;i<members->NumberOfProcessIdsInList;++i){auto value=members->ProcessIdList[i];if(i)ids<<',';ids<<value;hasSelf|=value==GetCurrentProcessId();hasWorker|=value==workerPid;hasExecutor|=value==executorPid;}
  require(hasSelf&&hasWorker&&!hasExecutor,"not-the-contained-sdk-job");
  std::array<wchar_t,32768> image{};DWORD length=GetModuleFileNameW(nullptr,image.data(),static_cast<DWORD>(image.size()));require(length>0&&length<image.size(),"self-image");
  auto attempt=[&](bool escape){std::wstring command=L"\""+std::wstring(image.data())+L"\" breakaway-child";STARTUPINFOW startup{};startup.cb=sizeof(startup);PROCESS_INFORMATION process{};
    BOOL ok=CreateProcessW(image.data(),command.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED|CREATE_NO_WINDOW|(escape?CREATE_BREAKAWAY_FROM_JOB:0),nullptr,nullptr,&startup,&process);DWORD error=ok?0:GetLastError();
    if(ok){Handle child,thread;child.value=process.hProcess;thread.value=process.hThread;require(TerminateProcess(child.value,0)!=0,"breakaway-fixture-stop");require(WaitForSingleObject(child.value,5000)==WAIT_OBJECT_0,"breakaway-fixture-close");}
    return std::pair<bool,DWORD>(ok!=0,error);};
  auto normal=attempt(false);require(normal.first,"raw-child-create-baseline");auto escape=attempt(true);
  std::string report="\"jobFlags\":"+std::to_string(flags)+",\"jobProcessIds\":["+ids.str()+"],\"expectedWorkerPid\":"+std::to_string(workerPid)+",\"expectedExecutorPid\":"+std::to_string(executorPid)+",\"normalSuspendedChildCreatedAndClosed\":true,\"rawBreakawayCreated\":"+(escape.first?"true":"false")+",\"rawBreakawayError\":"+std::to_string(escape.second);
  line("{\"kind\":\"job-proof\","+report+"}");require(!escape.first&&escape.second==ERROR_ACCESS_DENIED,"raw-breakaway-was-not-denied");return report;
}
int wmain(int argc,wchar_t** argv){
  try{
    if(argc==2&&std::wstring(argv[1])==L"breakaway-child")return 0;
    require(argc==6,"arguments");std::wstring mode=argv[1],key=argv[2],nonce=argv[3];require(lowerHex(key,16)&&lowerHex(nonce,24),"fixed-identity");
    DWORD workerPid=static_cast<DWORD>(std::stoul(argv[4])),executorPid=static_cast<DWORD>(std::stoul(argv[5]));require(workerPid&&executorPid&&workerPid!=executorPid,"process-identities");
    Api api;Identity id=identity(api);jobProof(workerPid,executorPid);std::wstring gd=absolute(id.root,globalLeaf(key)),sd=id.session?absolute(id.root,sessionLeaf(id.session,key)):gd;
    std::wstring eventLeaf=L"isolation-event-"+nonce,sectionLeaf=L"isolation-section-"+nonce;
    if(mode==L"identity"){line("{\"kind\":\"identity\","+identityFields(id)+"}");return 0;}
    if(mode==L"absent"){
      Handle g,s;NTSTATUS gs=openDir(api,gd,g),ss=openDir(api,sd,s);
      line("{\"kind\":\"absence\","+identityFields(id)+",\"globalDirectory\":"+status(gs)+",\"sessionDirectory\":"+status(ss)+"}");require(missing(gs)&&missing(ss),"namespace-still-live");return 0;
    }
    require(mode==L"hold","mode");Handle g,s,event,section;NTSTATUS gs=openDir(api,gd,g),ss=openDir(api,sd,s);require(gs==0&&ss==0,"redirected-directory-open");
    // Match MSYS child-object behavior: an explicit NULL DACL, not a stronger
    // test ACL that could hide a namespace traversal/isolation failure.
    SECURITY_DESCRIPTOR security{};require(InitializeSecurityDescriptor(&security,SECURITY_DESCRIPTOR_REVISION)!=0,"sd-init");require(SetSecurityDescriptorDacl(&security,TRUE,nullptr,FALSE)!=0,"null-dacl");
    Name eventName(eventLeaf,g.value,&security);NTSTATUS es=api.createEvent(&event.value,EVENT_ALL_ACCESS,&eventName.attributes,0,FALSE);require(es==0,"own-event-create");
    LARGE_INTEGER size{};size.QuadPart=4096;Name sectionName(sectionLeaf,g.value,&security);NTSTATUS ms=api.createSection(&section.value,0xf001f,&sectionName.attributes,&size,PAGE_READWRITE,SEC_COMMIT,nullptr);require(ms==0,"own-section-create");
    View view;view.value=MapViewOfFile(section.value,FILE_MAP_READ|FILE_MAP_WRITE,0,0,4096);require(view.value!=nullptr,"own-section-map");std::string marker="NEMOCLAW_SECTION_"+utf8(nonce);memcpy(view.value,marker.data(),marker.size());require(memcmp(view.value,marker.data(),marker.size())==0,"own-section-readback");
    line("{\"kind\":\"ready\","+identityFields(id)+",\"key\":"+quote(utf8(key))+",\"globalDirectory\":"+quote(utf8(gd))+",\"sessionDirectory\":"+quote(utf8(sd))+",\"nullDaclChildren\":true,\"ownEvent\":"+status(es)+",\"ownSection\":"+status(ms)+",\"ownSectionReadback\":true}");
    bool checked=false;
    for(int count=0;count<3;++count){
      std::string command=readLine();
      if(command=="stop"){line("{\"kind\":\"closed\",\"checked\":"+std::string(checked?"true":"false")+"}");return 0;}
      require(!checked&&command.starts_with("check "),"command");std::wstring other(command.begin()+6,command.end());
      auto split=id.root.rfind(L'\\');require(split!=std::wstring::npos&&other.starts_with(id.root.substr(0,split+1))&&other!=id.root,"foreign-root");std::wstring sid=other.substr(split+1);PSID parsed=nullptr;require(ConvertStringSidToSidW(sid.c_str(),&parsed)!=0,"foreign-sid");bool valid=IsValidSid(parsed)&&sid.starts_with(L"S-1-15-2-");LocalFree(parsed);require(valid,"foreign-sid-family");
      std::wstring foreign=absolute(other,globalLeaf(key)),foreignSession=id.session?absolute(other,sessionLeaf(id.session,key)):foreign;
      std::wstring ep=absolute(foreign,eventLeaf),mp=absolute(foreign,sectionLeaf);
      // Each minimal right is requested independently. Denial of ALL_ACCESS
      // alone would not rule out a usable synchronization or mapping handle.
      auto directory=[&](std::wstring name,ACCESS_MASK mask){Handle opened;Name object(name);return api.openDirectory(&opened.value,mask,&object.attributes);};
      auto eventOpen=[&](ACCESS_MASK mask){Handle opened;Name object(ep);return api.openEvent(&opened.value,mask,&object.attributes);};
      auto sectionOpen=[&](ACCESS_MASK mask){Handle opened;Name object(mp);return api.openSection(&opened.value,mask,&object.attributes);};
      std::vector<std::pair<std::string,NTSTATUS>> checks={
        {"foreignDirectory",directory(foreign,0x2000f)},
        {"foreignGlobalQuery",directory(foreign,0x1)},
        {"foreignGlobalCreateObject",directory(foreign,0x4)},
        {"foreignGlobalCreateSubdirectory",directory(foreign,0x8)},
        {"foreignSessionQuery",directory(foreignSession,0x1)},
        {"foreignSessionCreateObject",directory(foreignSession,0x4)},
        {"foreignSessionCreateSubdirectory",directory(foreignSession,0x8)},
        {"foreignEvent",eventOpen(EVENT_ALL_ACCESS)},
        {"foreignEventSynchronize",eventOpen(SYNCHRONIZE)},
        {"foreignEventModifyState",eventOpen(EVENT_MODIFY_STATE)},
        {"foreignSection",sectionOpen(SECTION_MAP_READ)},
        {"foreignSectionMapWrite",sectionOpen(SECTION_MAP_WRITE)}
      };
      std::wstring original=L"\\BaseNamedObjects\\msys-2.0S5-"+key;Name originalName(original,nullptr,&security,0x80);Handle glob;
      checks.emplace_back("originalGlobalCreate",api.createDirectory(&glob.value,0x2000f,&originalName.attributes));
      std::string fields;bool allDenied=true;constexpr auto denied=static_cast<NTSTATUS>(0xc0000022u);
      for(const auto& check:checks){fields+=","+quote(check.first)+":"+status(check.second);allDenied=allDenied&&check.second==denied;}
      line("{\"kind\":\"denials\","+identityFields(id)+",\"foreignRoot\":"+quote(utf8(other))+fields+"}");
      require(allDenied,"isolation-denial-failed");checked=true;
    }
    throw std::runtime_error("command-count");
  }catch(const std::exception& error){line("{\"kind\":\"failure\",\"error\":"+quote(error.what())+",\"win32\":"+std::to_string(GetLastError())+"}");return 1;}
}
