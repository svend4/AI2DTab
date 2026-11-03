"""Запускает несколько прогонов run_arm.py параллельно.

    python3 matrix.py --work WORK --out OUT --workers 4 repo_lookup:cards:1 repo_lookup:tools:1 chat:cards:1:0,1

Задача = набор:способ:номер_прогона[:сессии_чата]. Вывод каждой задачи — в OUT/logs/.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


async def run_job(spec: str, ns, sem: asyncio.Semaphore):
    parts = spec.split(":")
    s, arm, run = parts[0], parts[1], parts[2]
    cmd = [sys.executable, str(HERE / "run_arm.py"), "--work", ns.work, "--set", s, "--arm", arm, "--run", run, "--out", ns.out]
    if len(parts) > 3:
        cmd += ["--sessions", parts[3]]
    async with sem:
        log = Path(ns.out) / "logs" / (spec.replace(":", "_").replace(",", "-") + ".log")
        log.parent.mkdir(parents=True, exist_ok=True)
        with open(log, "w") as f:
            p = await asyncio.create_subprocess_exec(*cmd, stdout=f, stderr=asyncio.subprocess.STDOUT)
            rc = await p.wait()
        tail = log.read_text().strip().split("\n")[-1] if log.stat().st_size else ""
        print(f"[{rc}] {spec}: {tail}", flush=True)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("jobs", nargs="+")
    ns = ap.parse_args()
    sem = asyncio.Semaphore(ns.workers)
    await asyncio.gather(*[run_job(j, ns, sem) for j in ns.jobs])


if __name__ == "__main__":
    asyncio.run(main())
