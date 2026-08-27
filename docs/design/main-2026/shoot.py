#!/usr/bin/env python3
"""Bake a body class into a temp HTML copy, then headless-screenshot it."""
from __future__ import annotations

import pathlib
import subprocess
import time

HERE = pathlib.Path(__file__).resolve().parent
SRC = (HERE / "index.html").read_text(encoding="utf-8")
CHROME = "/usr/local/bin/google-chrome"

SHOTS = [
    ("v1 still", "v1-ion-lattice.png"),
    ("v1 sheet still", "v1-start-sheet.png"),
    ("v2 still", "v2-phosphor-ribbon.png"),
    ("v3 still", "v3-amber-reticle.png"),
    ("v4 still", "v4-void-glass.png"),
    ("v5 still", "v5-chrome-bezel.png"),
]


def shoot(body_class: str, name: str) -> None:
    html = SRC.replace('<body class="v1">', f'<body class="{body_class}">', 1)
    if "sheet" in body_class:
        html = html.replace("display: none; position: absolute; inset: 0; z-index: 10;", "display: grid; position: absolute; inset: 0; z-index: 10;")
    tmp = pathlib.Path("/tmp") / f"legion-{name}.html"
    tmp.write_text(html, encoding="utf-8")
    out = HERE / name
    profile = pathlib.Path("/tmp") / f"chrome-{name}"
    subprocess.run(["rm", "-rf", str(profile)], check=False)
    if out.exists():
        out.unlink()
    cmd = [
        CHROME,
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-background-networking",
        "--hide-scrollbars",
        "--window-size=1440,900",
        f"--user-data-dir={profile}",
        f"--screenshot={out}",
        tmp.as_uri(),
    ]
    print("shoot", name, flush=True)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 18
    while time.time() < deadline:
        if out.exists() and out.stat().st_size > 20000:
            break
        if proc.poll() is not None:
            break
        time.sleep(0.2)
    proc.kill()
    try:
        proc.wait(timeout=4)
    except subprocess.TimeoutExpired:
        proc.kill()
    size = out.stat().st_size if out.exists() else 0
    print((" ok" if size > 20000 else " FAIL"), size, flush=True)
    if size < 20000:
        raise SystemExit(f"screenshot failed: {name} size={size}")


def main() -> None:
    for body_class, name in SHOTS:
        shoot(body_class, name)


if __name__ == "__main__":
    main()
