"""Reuse public crates.io downloads; Cargo still builds and runs each workload."""
import gzip
import hashlib
import json
import pathlib
import re
import shutil
import sys
import tarfile
import tempfile
import time
import tomllib


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def downloads(root, action, archive, maximum, expected=None):
    started = time.monotonic()
    lock_path = root / 'source/Cargo.lock'
    prepared = json.loads((root / 'source.json').read_text())
    if digest(lock_path) != prepared['identity']['lockSha256']:
        raise ValueError('Cargo.lock changed after source preparation')
    lock = tomllib.loads(lock_path.read_text())
    checksums = {}
    for package in lock.get('package', []):
        if package.get('source') == 'registry+https://github.com/rust-lang/crates.io-index':
            name = f"{package['name']}-{package['version']}.crate"
            checksum = package.get('checksum', '')
            if re.fullmatch(r'[A-Za-z0-9_.+-]+\.crate', name) and re.fullmatch(r'[a-f0-9]{64}', checksum):
                checksums[name] = checksum
    cache = root / '.cargo/registry/cache'
    # These are Cargo's public crates.io namespaces. Never copy configuration,
    # credentials, git databases, unpacked sources, or compiler outputs.
    namespace = re.compile(r'(index\.crates\.io|github\.com)-[a-f0-9]{16}')
    count = size = 0
    if action == 'save':
        files = []
        for directory in sorted(cache.glob('*')):
            if directory.is_symlink() or not directory.is_dir() or not namespace.fullmatch(directory.name):
                continue
            for name, checksum in sorted(checksums.items()):
                path = directory / name
                if path.is_symlink() or not path.is_file():
                    continue
                length = 512 + ((path.stat().st_size + 511) // 512) * 512
                if size + length > maximum or digest(path) != checksum:
                    continue
                files.append(path)
                size += length
        if not files:
            return {'saved': False, 'reason': 'No matching crates.io downloads within the byte limit'}
        with (
            archive.open('xb') as output,
            gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=1, mtime=0) as compressed,
            tarfile.open(fileobj=compressed, mode='w') as bundle,
        ):
            for path in files:
                info = bundle.gettarinfo(str(path), arcname=str(path.relative_to(cache)))
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode = 0o600
                with path.open('rb') as stream:
                    bundle.addfile(info, stream)
        if archive.stat().st_size > maximum:
            archive.unlink()
            return {'saved': False, 'reason': 'Compressed archive exceeds the byte limit'}
        return {'schemaVersion': 1, 'kind': 'cargo-downloads', 'sha256': digest(archive),
                'bytes': archive.stat().st_size, 'uncompressedBytes': size, 'crates': len(files),
                'seconds': time.monotonic() - started}
    if action != 'restore':
        raise ValueError('Use save or restore')
    if archive.stat().st_size > maximum or digest(archive) != expected:
        raise ValueError('Download cache digest or byte limit differs')
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        staging = pathlib.Path(temporary)
        selected = []
        seen = set()
        with tarfile.open(archive, 'r:gz') as bundle:
            for member in bundle:
                parts = member.name.split('/')
                size += 512 + ((member.size + 511) // 512) * 512
                if (len(parts) != 2 or not namespace.fullmatch(parts[0]) or
                        not re.fullmatch(r'[A-Za-z0-9_.+-]+\.crate', parts[1]) or
                        not member.isfile() or member.size <= 0 or size > maximum or member.name in seen):
                    raise ValueError('Invalid download cache entry or expansion limit')
                seen.add(member.name)
                if len(seen) > 2 * len(checksums):
                    raise ValueError('Download cache has too many entries for this lockfile')
                # One member per locked crate per public Cargo namespace is enough.
                # Ignore other revisions' crates without ever extracting them.
                if parts[1] not in checksums:
                    continue
                target = staging / parts[0] / parts[1]
                target.parent.mkdir(exist_ok=True)
                with target.open('xb') as output:
                    shutil.copyfileobj(bundle.extractfile(member), output)
                if digest(target) != checksums[parts[1]]:
                    raise ValueError('Crate checksum differs from the requested Cargo.lock')
                selected.append((target, cache / member.name))
        for source, target in selected:
            # Do not follow paths redirected by repository setup commands.
            if any(path.is_symlink() for path in [cache, *cache.parents, target.parent, target]):
                raise ValueError('Download cache destination contains a symlink')
        for source, target in selected:
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
            count += 1
    return {'restored': count > 0, 'crates': count, 'seconds': time.monotonic() - started}


if __name__ == '__main__':
    action, path, limit, *expected = sys.argv[1:]
    root = pathlib.Path('/workspace')
    try:
        maximum = int(limit)
        if maximum <= 0:
            raise ValueError('Positive cache byte limit required')
        result = downloads(root, action, pathlib.Path(path), maximum, expected[0] if expected else None)
    except Exception as error:
        # Optional acceleration must never turn a valid workload into a failure.
        result = {'restored': False, 'saved': False, 'reason': str(error)}
    if action == 'restore':
        (root / 'dependency-cache-result.json').write_text(json.dumps(result) + '\n')
    print(json.dumps(result))
