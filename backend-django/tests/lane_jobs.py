"""Jobs the Lane tests run in child processes (a light module: the forkserver child imports only this)."""

import time
from pathlib import Path


def slow(seconds: float) -> str:
    time.sleep(seconds)
    return "slow done"


def touch(path: str) -> str:
    Path(path).write_text("ran")
    return "touched"


def hog(mb: int) -> int:
    return len(bytearray(mb * 1024 * 1024))
