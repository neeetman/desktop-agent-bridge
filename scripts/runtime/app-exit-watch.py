"""Observe only supplied desktop PIDs; report clean exit vs crash without touching UI."""
import sys as _bridge_sys
from pathlib import Path as _BridgePath
_bridge_sys.path.insert(0, str(_BridgePath(__file__).resolve().parents[1] / 'lib'))
from bridge_paths import ROOT, source_file
import ctypes
from ctypes import wintypes
import json
import sys

kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.OpenProcess.restype=wintypes.HANDLE
kernel.CloseHandle.argtypes=[wintypes.HANDLE]
kernel.GetExitCodeProcess.argtypes=[wintypes.HANDLE,ctypes.POINTER(wintypes.DWORD)]
kernel.WaitForMultipleObjects.argtypes=[wintypes.DWORD,ctypes.POINTER(wintypes.HANDLE),wintypes.BOOL,wintypes.DWORD]
kernel.WaitForMultipleObjects.restype=wintypes.DWORD
rows=[]
for app,pid in json.loads(sys.argv[1]).items():
 handle=kernel.OpenProcess(0x1000|0x100000,False,int(pid))
 if handle:rows.append((app,pid,handle))
try:
 while rows:
  handles=(wintypes.HANDLE*len(rows))(*(row[2] for row in rows))
  result=kernel.WaitForMultipleObjects(len(rows),handles,False,1000)
  if result<len(rows):
   app,pid,handle=rows.pop(result)
   code=wintypes.DWORD()
   if kernel.GetExitCodeProcess(handle,ctypes.byref(code)):
    print(json.dumps({'app':app,'pid':pid,'exitCode':code.value,'clean':code.value==0}),flush=True)
   kernel.CloseHandle(handle)
finally:
 for _,_,handle in rows:kernel.CloseHandle(handle)
