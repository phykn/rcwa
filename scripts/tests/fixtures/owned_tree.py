"""Test-only stubborn descendants. Installed over a copied private runtime."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1]
if len(sys.argv) == 2 and sys.argv[1] not in {"child", "grandchild"}:
    if sys.stdin.readline() != "start\n":
        raise SystemExit(1)
    level = "runtime"
else:
    level = sys.argv[1]
for number in (signal.SIGINT, signal.SIGTERM, *([signal.SIGBREAK] if os.name == "nt" else [])):
    signal.signal(number, signal.SIG_IGN)
(root / f"{level}.pid").write_text(str(os.getpid()))
if level != "grandchild":
    subprocess.Popen([sys.executable, __file__, "child" if level == "runtime" else "grandchild"])
if level == "runtime":
    print(json.dumps({"event": "ready"}), flush=True)
while True:
    time.sleep(1)
