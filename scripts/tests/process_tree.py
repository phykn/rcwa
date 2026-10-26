import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import NamedTuple


class Identity(NamedTuple):
    pid: int
    created: int


class Process(NamedTuple):
    parent: int
    executable: str
    running: bool
    created: int | None
    error: str | None = None


def windows_creation(handle):
    """Query a retained handle, including a terminated-but-not-reused process."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
    if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                  ctypes.byref(system), ctypes.byref(user)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (created.dwHighDateTime << 32) | created.dwLowDateTime


def root_identity(process):
    if os.name == "nt":
        return Identity(process.pid, windows_creation(int(process._handle)))
    fields = Path(f"/proc/{process.pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return Identity(process.pid, int(fields[19]))


def processes():
    """Read process ancestry and birth identities; unknown is never dead."""
    if os.name != "nt":
        result = {}
        for entry in Path("/proc").glob("[0-9]*"):
            try:
                fields = (entry / "stat").read_text().rsplit(") ", 1)[1].split()
                error = None
                try:
                    command = os.readlink(entry / "exe") if fields[0] != "Z" else "<zombie>"
                except PermissionError as failure:
                    # Foreign-UID executable names may be hidden; retain the
                    # readable birth/parent identity and never drop the process.
                    command, error = "<unreadable>", str(failure)
                result[int(entry.name)] = Process(int(fields[1]), command, fields[0] != "Z", int(fields[19]), error)
            except (FileNotFoundError, ProcessLookupError):
                pass
            except PermissionError as error:
                raise AssertionError(f"Cannot observe process {entry.name}: {error}") from error
        return result
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class Entry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
        ]
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    def snapshot():
        handle = kernel.CreateToolhelp32Snapshot(2, 0)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        entries = {}
        try:
            entry = Entry()
            entry.dwSize = ctypes.sizeof(entry)
            available = kernel.Process32FirstW(handle, ctypes.byref(entry))
            while available:
                entries[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile)
                available = kernel.Process32NextW(handle, ctypes.byref(entry))
            error = ctypes.get_last_error()
            if error != 18:  # ERROR_NO_MORE_FILES is the only successful end.
                raise ctypes.WinError(error)
        finally:
            kernel.CloseHandle(handle)
        return entries

    result = {}
    for pid, (parent, executable) in snapshot().items():
        created, error = None, None
        process = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if process:
            try:
                created = windows_creation(process)
            except OSError as failure:
                error = str(failure)
            finally:
                kernel.CloseHandle(process)
        else:
            error = f"OpenProcess error {ctypes.get_last_error()}"
        result[pid] = Process(parent, executable, True, created, error)
    if any(record.created is None for record in result.values()):
        # A short-lived process may exit between enumeration and OpenProcess.
        # Only a second census can establish absence; access denied is not dead.
        present = snapshot()
        result = {pid: record for pid, record in result.items() if record.created is not None or pid in present}
    return result


def identities(pids, table=None):
    table = processes() if table is None else table
    result = set()
    for pid in pids:
        record = table.get(pid)
        assert record is not None and record.created is not None, f"Cannot identify owned PID {pid}: {record}"
        result.add(Identity(pid, record.created))
    return result


def descendants(root, table=None):
    table = processes() if table is None else table
    owned = set()
    pending = [root]
    while pending:
        parent = pending.pop()
        record = table.get(parent.pid)
        if record is not None:
            assert record.created is not None, f"Cannot identify parent {parent}: {record}"
        # If this PID was reused, children born before the replacement still
        # belong to the original parent; later children belong to its successor.
        replaced_at = record.created if record is not None and record.created != parent.created else None
        for pid, child in table.items():
            if child.parent != parent.pid or not child.running:
                continue
            assert child.created is not None, f"Cannot identify candidate child of {parent}: {pid}: {child}"
            if child.created < parent.created or (replaced_at is not None and child.created >= replaced_at):
                continue  # Windows keeps a dead parent's PID after it is reused.
            identity = Identity(pid, child.created)
            if identity != root and identity not in owned:
                owned.add(identity)
                pending.append(identity)
    return owned


def assert_stopped(observed, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        table = processes()
        alive = {}
        for identity in observed:
            record = table.get(identity.pid)
            if record is None or not record.running:
                continue
            assert record.created is not None, f"Cannot observe owned identity {identity}: {record}"
            if record.created == identity.created:
                alive[identity] = record
        if not alive:
            return
        if time.monotonic() >= deadline:
            raise AssertionError(f"Owned processes remain running: {alive}")
        time.sleep(0.05)


def interrupt(process, repeat=1, *, ctrl_break=False):
    if os.name != "nt":
        for _ in range(repeat):
            process.send_signal(signal.SIGINT)
            time.sleep(0.02)
        return
    # The tested supervisor has a private console. A separate helper attaches
    # only to that console, ignores Ctrl+C itself, and sends the real console
    # CTRL_C_EVENT. No Ctrl+C is broadcast into pytest/CI's parent console.
    code = r'''
import ctypes, sys, time
from ctypes import wintypes
k = ctypes.WinDLL("kernel32", use_last_error=True)
k.FreeConsole()
if not k.AttachConsole(int(sys.argv[1])):
    raise ctypes.WinError(ctypes.get_last_error())
# AttachConsole resets the native handler table; Python's CRT SIGBREAK handler
# is no longer registered. Keep a fresh native callback alive for both events.
handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
@handler_type
def handler(event):
    return event in (0, 1)
k.SetConsoleCtrlHandler.argtypes = [handler_type, wintypes.BOOL]
k.SetConsoleCtrlHandler.restype = wintypes.BOOL
if not k.SetConsoleCtrlHandler(handler, True):
    raise ctypes.WinError(ctypes.get_last_error())
for _ in range(int(sys.argv[2])):
    if not k.GenerateConsoleCtrlEvent(int(sys.argv[3]), 0):
        raise ctypes.WinError(ctypes.get_last_error())
    time.sleep(0.02)
time.sleep(0.2)
k.FreeConsole()
'''
    subprocess.run([sys.executable, "-c", code, str(process.pid), str(repeat), "1" if ctrl_break else "0"], check=True, timeout=5)
