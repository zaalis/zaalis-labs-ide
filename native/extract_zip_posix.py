#!/usr/bin/env python3
import os
import shutil
import stat
import sys
import zipfile


def extract(zip_path, dest):
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if not name or name.startswith("/") or ".." in name.split("/"):
                raise RuntimeError(f"unsafe zip entry: {name!r}")

            target = os.path.join(dest, name)
            mode = info.external_attr >> 16

            if name.endswith("/"):
                os.makedirs(target, exist_ok=True)
                if mode:
                    os.chmod(target, mode & 0o777)
                continue

            os.makedirs(os.path.dirname(target), exist_ok=True)

            if stat.S_ISLNK(mode):
                link_target = zf.read(info).decode("utf-8")
                if os.path.lexists(target):
                    os.unlink(target)
                os.symlink(link_target, target)
                continue

            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            if mode:
                os.chmod(target, mode & 0o7777)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_zip_posix.py <zip> <dest>", file=sys.stderr)
        sys.exit(1)
    extract(sys.argv[1], sys.argv[2])
