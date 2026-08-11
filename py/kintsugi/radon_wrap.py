"""Run `radon cc -s --min C .` tolerating a broken pyproject.toml.

Radon loads pyproject.toml at *import* time (before any CLI flag is
parsed) and raises on invalid TOML — so a repo whose pyproject.toml is
malformed (or just a stray marker file) makes the whole check crash and
silently report nothing. This wrapper temporarily renames a non-TOML
pyproject.toml aside, runs radon, and restores it. A valid config is
left untouched (radon reads it normally); exit code and stdout pass
through unchanged.
"""

import os
import shutil
import subprocess
import sys
import tomllib


def main(argv):
    root = os.getcwd()
    cfg = os.path.join(root, "pyproject.toml")
    hidden = None
    try:
        if os.path.exists(cfg):
            with open(cfg, "rb") as fh:
                tomllib.load(fh)  # raises TOMLDecodeError on bad content
        # Valid (or absent) — run plainly.
        return subprocess.call(["radon", "cc", "-s", "--min", "C", "."] + argv)
    except tomllib.TOMLDecodeError:
        hidden = cfg + ".kintsugi-hidden"
        # Move only if the aside name is free; otherwise radon will read the
        # bad config regardless and we surface the crash honestly.
        if os.path.exists(hidden):
            return subprocess.call(["radon", "cc", "-s", "--min", "C", "."] + argv)
        os.replace(cfg, hidden)
        try:
            return subprocess.call(["radon", "cc", "-s", "--min", "C", "."] + argv)
        finally:
            os.replace(hidden, cfg)
    finally:
        # If radon itself crashed (traceback to stderr), the return code is
        # non-zero; the wrapper passes that through exactly as radon would.
        pass


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
