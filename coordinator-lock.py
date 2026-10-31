"""Hold an OS file lock until the owning Node process closes stdin."""
import os
from pathlib import Path
import sys
import time


def main():
    file = Path(sys.argv[1])
    with file.open('a+b') as stream:
        if stream.seek(0, 2) == 0:
            stream.write(b'0')
            stream.flush()
        deadline = time.monotonic() + 6
        while True:
            try:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('Compatibility coordinator lock is busy')
                time.sleep(0.025)
        print('{"locked":true}', flush=True)
        try:
            sys.stdin.readline()
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


if __name__ == '__main__':
    main()
