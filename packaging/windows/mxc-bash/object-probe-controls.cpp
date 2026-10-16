// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Exercise handle ownership only. The contained probe entry point is not run.
#define wmain object_probe_entry_not_executed
#include "object-probe.cpp"
#undef wmain

int wmain(){
  try{
    unsigned passed=0;
    Handle borrowed;borrowed.value=CreateEventW(nullptr,FALSE,FALSE,nullptr);
    require(borrowed.value!=nullptr,"control-event-create");
    for(const auto code:{0xc0000022u,0xc0000034u,0x80000005u}){
      {
        Handle owner;
        const auto result=own_nt_object(owner,[&](PHANDLE output){*output=borrowed.value;return static_cast<NTSTATUS>(code);});
        require(result==static_cast<NTSTATUS>(code)&&owner.value==nullptr,"failed-output-adopted");
      }
      DWORD flags=0;require(GetHandleInformation(borrowed.value,&flags)!=0,"failed-output-closed-borrowed-handle");++passed;
    }
    for(const auto code:{0u,0x40000000u}){
      HANDLE adopted=nullptr;
      {
        Handle owner;
        const auto result=own_nt_object(owner,[&](PHANDLE output){
          require(DuplicateHandle(GetCurrentProcess(),borrowed.value,GetCurrentProcess(),output,0,FALSE,DUPLICATE_SAME_ACCESS)!=0,"control-duplicate");
          adopted=*output;return static_cast<NTSTATUS>(code);
        });
        require(result==static_cast<NTSTATUS>(code)&&owner.value==adopted,"successful-output-not-owned");
        DWORD flags=0;require(GetHandleInformation(adopted,&flags)!=0,"successful-output-closed-early");
      }
      DWORD flags=0;require(!GetHandleInformation(adopted,&flags)&&GetLastError()==ERROR_INVALID_HANDLE,"owned-output-not-closed");++passed;
    }
    for(HANDLE invalid:{static_cast<HANDLE>(nullptr),INVALID_HANDLE_VALUE}){
      Handle owner;bool rejected=false;
      try{own_nt_object(owner,[&](PHANDLE output){*output=invalid;return NTSTATUS(0);});}
      catch(const std::runtime_error&){rejected=true;}
      require(rejected&&owner.value==nullptr,"invalid-success-output-adopted");++passed;
    }
    bool invoked=false,rejected=false;
    try{own_nt_object(borrowed,[&](PHANDLE){invoked=true;return NTSTATUS(0);});}
    catch(const std::runtime_error&){rejected=true;}
    DWORD flags=0;require(rejected&&!invoked&&GetHandleInformation(borrowed.value,&flags),"existing-owner-replaced");++passed;
    std::cout<<"NT object ownership controls passed: "<<passed<<'\n';
    return passed==8?0:1;
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
