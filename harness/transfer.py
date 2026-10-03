"""Transfer a regular file over an existing SSH channel with bounded memory."""
import hashlib
import json
import os
import pathlib
import stat
import sys


def copy(source, size, target=None):
    digest = hashlib.sha256()
    remaining = size
    while remaining:
        data = source.read(min(1024 * 1024, remaining))
        if not data:
            raise RuntimeError('File ended before its recorded size')
        if target is not None:
            target.write(data)
        digest.update(data)
        remaining -= len(data)
    if source.read(1):
        raise RuntimeError('File exceeds its recorded size')
    return digest.hexdigest()


def main():
    mode, path, *args = sys.argv[1:]
    if mode == 'receive':
        destination, size, expected = args
        staging = pathlib.Path(path)
        staging.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as target:
            actual = copy(sys.stdin.buffer, int(size), target)
            if actual != expected:
                raise RuntimeError('Upload digest mismatch; staging retained')
            target.flush()
            os.fsync(target.fileno())
        os.link(staging, destination)
        staging.unlink()
        print(json.dumps({'size': int(size), 'sha256': actual}))
        return
    if mode not in ['metadata', 'send']:
        raise ValueError('Use metadata, send or receive')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Transfer requires a regular file')
        if mode == 'metadata':
            print(json.dumps({'size': info.st_size, 'sha256': copy(source, info.st_size)}))
        else:
            size, expected = args
            if info.st_size != int(size):
                raise RuntimeError('File size changed before export')
            actual = copy(source, int(size), sys.stdout.buffer)
            sys.stdout.buffer.flush()
            if actual != expected:
                raise RuntimeError('File changed during export; inspect the partial output')


if __name__ == '__main__':
    main()
