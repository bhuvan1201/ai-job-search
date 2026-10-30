#!/usr/bin/env python3
"""Install or remove a local schedule that runs `/daily` every weekday morning.

macOS: writes a launchd agent to ~/Library/LaunchAgents/com.ai-job-search.daily.plist
and loads it. Linux: adds a tagged line to the user's crontab. Either way the job
runs `claude -p "/daily --quiet"` from this repo's root and appends the console
output to job_scraper/daily.log (gitignored personal output).

Nothing here runs the pipeline itself; it only registers the schedule. The
`claude` binary must be on PATH for the scheduler's environment - launchd and
cron start with a minimal PATH, so the installed job uses the absolute path that
`shutil.which("claude")` resolves at install time.

    python3 tools/schedule_daily.py                 # weekdays 07:30, local time
    python3 tools/schedule_daily.py --time 06:45
    python3 tools/schedule_daily.py --args "/daily --gmail --quiet"
    python3 tools/schedule_daily.py --dry-run       # print what would be installed
    python3 tools/schedule_daily.py --remove
"""

from __future__ import annotations

import argparse
import os
import platform
import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LABEL = "com.ai-job-search.daily"
CRON_TAG = "# ai-job-search:daily"
LOG_REL = Path("job_scraper") / "daily.log"


def parse_time(value: str) -> tuple[int, int]:
    try:
        hh, mm = value.split(":")
        hour, minute = int(hh), int(mm)
    except ValueError:
        raise SystemExit(f"--time must be HH:MM, got {value!r}")
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise SystemExit(f"--time out of range: {value!r}")
    return hour, minute


def resolve_claude() -> str:
    found = shutil.which("claude")
    if not found:
        raise SystemExit(
            "could not find `claude` on PATH - install Claude Code first, or run this "
            "script from a shell where `claude --version` works"
        )
    return found


def job_command(claude_bin: str, prompt_args: str) -> str:
    log = REPO_ROOT / LOG_REL
    return (
        f"cd {shlex.quote(str(REPO_ROOT))} && mkdir -p {shlex.quote(str(log.parent))} && "
        f"{shlex.quote(claude_bin)} -p {shlex.quote(prompt_args)} >> {shlex.quote(str(log))} 2>&1"
    )


# --------------------------------------------------------------------------- macOS


def launchd_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def install_launchd(hour: int, minute: int, command: str, dry_run: bool) -> None:
    plist = {
        "Label": LABEL,
        "ProgramArguments": ["/bin/sh", "-c", command],
        "StartCalendarInterval": [
            {"Weekday": wd, "Hour": hour, "Minute": minute} for wd in range(1, 6)
        ],
        "RunAtLoad": False,
        "StandardOutPath": str(REPO_ROOT / LOG_REL),
        "StandardErrorPath": str(REPO_ROOT / LOG_REL),
    }
    path = launchd_path()
    if dry_run:
        print(f"would write {path}:")
        print(plistlib.dumps(plist).decode())
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        subprocess.run(["launchctl", "unload", str(path)], check=False, capture_output=True)
    path.write_bytes(plistlib.dumps(plist))
    subprocess.run(["launchctl", "load", str(path)], check=True)
    print(f"installed launchd agent {LABEL} -> weekdays {hour:02d}:{minute:02d}")
    print(f"  plist: {path}")
    print(f"  log:   {REPO_ROOT / LOG_REL}")
    print(f"  test now: launchctl start {LABEL}")


def remove_launchd(dry_run: bool) -> None:
    path = launchd_path()
    if not path.exists():
        print("no launchd agent installed")
        return
    if dry_run:
        print(f"would unload and delete {path}")
        return
    subprocess.run(["launchctl", "unload", str(path)], check=False, capture_output=True)
    path.unlink()
    print(f"removed {path}")


# --------------------------------------------------------------------------- Linux


def read_crontab() -> list[str]:
    if shutil.which("crontab") is None:
        raise SystemExit("`crontab` is not installed - install cron (e.g. `sudo apt install cron`) or use a systemd timer")
    proc = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
    if proc.returncode != 0:
        return []
    return proc.stdout.splitlines()


def write_crontab(lines: list[str]) -> None:
    text = "\n".join(lines).rstrip("\n") + "\n"
    subprocess.run(["crontab", "-"], input=text, text=True, check=True)


def install_cron(hour: int, minute: int, command: str, dry_run: bool) -> None:
    line = f"{minute} {hour} * * 1-5 {command} {CRON_TAG}"
    existing = [l for l in read_crontab() if CRON_TAG not in l]
    if dry_run:
        print("would add crontab line:")
        print(line)
        return
    write_crontab(existing + [line])
    print(f"installed cron line -> weekdays {hour:02d}:{minute:02d}")
    print(f"  log: {REPO_ROOT / LOG_REL}")


def remove_cron(dry_run: bool) -> None:
    current = read_crontab()
    kept = [l for l in current if CRON_TAG not in l]
    if len(kept) == len(current):
        print("no ai-job-search cron line installed")
        return
    if dry_run:
        print("would remove the tagged crontab line")
        return
    write_crontab(kept)
    print("removed the ai-job-search cron line")


# --------------------------------------------------------------------------- main


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--time", default="07:30", help="local time HH:MM, weekdays (default 07:30)")
    ap.add_argument("--args", default="/daily --quiet", help='prompt passed to `claude -p` (default "/daily --quiet")')
    ap.add_argument("--remove", action="store_true", help="uninstall the schedule")
    ap.add_argument("--dry-run", action="store_true", help="show what would change without doing it")
    ns = ap.parse_args(argv)

    system = platform.system()
    if system == "Darwin":
        installer, remover = install_launchd, remove_launchd
    elif system == "Linux":
        installer, remover = install_cron, remove_cron
    else:
        print(
            f"{system} is not supported by this helper. On Windows, create a Task Scheduler "
            f"task that runs: cmd /c \"cd /d {REPO_ROOT} && claude -p \\\"/daily --quiet\\\" >> "
            f"{LOG_REL} 2>&1\" on weekdays at your chosen time.",
            file=sys.stderr,
        )
        return 2

    if ns.remove:
        remover(ns.dry_run)
        return 0

    hour, minute = parse_time(ns.time)
    claude_bin = resolve_claude() if not ns.dry_run else (shutil.which("claude") or "claude")
    if not ns.args.lstrip().startswith("/daily"):
        raise SystemExit("--args must start with /daily; this helper schedules only the daily pipeline")
    installer(hour, minute, job_command(claude_bin, ns.args), ns.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
