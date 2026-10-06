#!/usr/bin/env python3
"""Run browser tests with this project's Python interpreter on every platform."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run(
    [shutil.which("npm") or "npm", "test"], cwd=root,
    env={**os.environ, "PYTHON": sys.executable}, check=True,
)
