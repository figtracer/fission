"""Preserve a stopped Reth execution database as bounded, verified local chunks."""
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tarfile
import time

ROOT = pathlib.Path('/workspace/ethereum-data')
# A chunk fits the existing three-minute SSH transfer on modest connections;
# resumable collection never repeats a complete multi-terabyte transfer.
CHUNK_BYTES = 64 * 1024 * 1024


def sha(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    with path.open('x') as file:
        json.dump(value, file, indent=2)
        file.flush()
        os.fsync(file.fileno())


def controller():
    spec = importlib.util.spec_from_file_location('ethereum', '/workspace/.fission/ethereum-node.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inspect(require_stopped=True):
    node = controller()
    current = read(ROOT / 'current.json') if (ROOT / 'current.json').exists() else None
    quiescent = not current or current.get('phase') == 'stopped' and node.stopped(node.units(current))
    if require_stopped and not quiescent:
        raise RuntimeError('Stop the recorded Reth/Lighthouse pair before preserving its database')
    snapshot = read(ROOT / 'snapshot.json')
    writer = current['reth']['sha256'] if current else snapshot['importer']['sha256']
    # Restore is supported with the pinned writer. A candidate can have migrated
    # database structures; matching its storage-version number alone is insufficient.
    if writer != sha(node.RETH):
        raise RuntimeError('Dataset reuse requires the pinned Reth writer; this candidate needs an explicit compatibility migration')
    if snapshot['manifestSha256'] != sha(ROOT / 'manifest.json') or snapshot.get('storageVersion') != 2 or snapshot.get('chainId') != 1:
        raise RuntimeError('Snapshot identity differs')
    files = [ROOT / 'snapshot.json', ROOT / 'manifest.json']
    files += sorted((ROOT / 'execution').rglob('*'))
    if not (ROOT / 'execution' / 'reth.toml').is_file() or any(path.is_symlink() or not path.is_file() and not path.is_dir() for path in files):
        raise RuntimeError('Dataset must contain regular files and directories from a complete import')
    files = [path for path in files if path.is_file()]
    return {'schemaVersion': 1, 'kind': 'reth-execution', 'chainId': 1, 'storageVersion': 2,
            'writerSha256': writer, 'manifestSha256': snapshot['manifestSha256'], 'snapshotBlock': snapshot['block'],
            'quiescent': quiescent, 'fileBytes': sum(path.stat().st_size for path in files), 'fileCount': len(files),
            'observedAt': time.time()}, files


class Chunks:
    def __init__(self, directory, maximum):
        self.directory, self.maximum = directory, maximum
        self.parts, self.file, self.size = [], None, 0

    def write(self, data):
        if self.size + len(data) > self.maximum:
            raise RuntimeError('Dataset archive exceeds the byte limit')
        count = len(data)
        while data:
            if self.file is None:
                self.file = (self.directory / f'part-{len(self.parts):06d}').open('xb')
            amount = min(len(data), CHUNK_BYTES - self.file.tell())
            self.file.write(data[:amount]); data = data[amount:]; self.size += amount
            if self.file.tell() == CHUNK_BYTES:
                self.finish()
        return count

    def finish(self):
        if self.file:
            self.file.flush(); os.fsync(self.file.fileno())
            path = pathlib.Path(self.file.name); self.file.close(); self.file = None
            self.parts.append({'path': path.name, 'bytes': path.stat().st_size, 'sha256': sha(path)})


class Joined:
    def __init__(self, directory, parts):
        self.paths = iter(directory / part['path'] for part in parts)
        self.file = None

    def read(self, size):
        output = bytearray()
        while len(output) < size:
            if self.file is None:
                path = next(self.paths, None)
                if path is None:
                    break
                self.file = path.open('rb')
            data = self.file.read(size - len(output))
            if data:
                output.extend(data)
            else:
                self.file.close(); self.file = None
        return bytes(output)


def main():
    mode, directory, maximum = sys.argv[1:]
    directory = pathlib.Path(directory); maximum = int(maximum)
    if maximum <= 0:
        raise ValueError('Set a positive byte limit')
    with (ROOT / 'mutation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if mode in ['inspect', 'save']:
            identity, files = inspect(mode == 'save')
            if mode == 'inspect':
                print(json.dumps(identity)); return
            if identity['fileBytes'] > maximum or shutil.disk_usage(ROOT).free < maximum:
                raise RuntimeError('Byte limit or free guest staging space is insufficient')
            directory.mkdir(parents=True, exist_ok=False)
            output = Chunks(directory, maximum)
            try:
                with tarfile.open(fileobj=output, mode='w|') as archive:
                    for path in files:
                        archive.add(path, arcname=str(path.relative_to(ROOT)), recursive=False)
            finally:
                output.finish()
            after, _ = inspect()
            if any(after[key] != identity[key] for key in ['writerSha256', 'manifestSha256', 'fileBytes', 'fileCount']):
                raise RuntimeError('Dataset changed during export; preserve the partial archive')
            value = {**identity, 'archiveBytes': output.size, 'parts': output.parts, 'savedAt': time.time()}
            write(directory / 'manifest.json', value)
            print(json.dumps(value)); return
        if mode not in ['restore', 'restore-inspect']:
            raise ValueError('Use inspect, save, or restore')
        value = read(directory / 'manifest.json')
        node = controller()
        if value.get('kind') != 'reth-execution' or value.get('chainId') != 1 or value.get('storageVersion') != 2 or value.get('writerSha256') != sha(node.RETH):
            raise RuntimeError('Dataset is incompatible with the prepared Reth writer')
        if any((ROOT / name).exists() for name in ['execution', 'snapshot.json', 'current.json', 'snapshot-attempt.json']):
            raise RuntimeError('Preserve the existing node state; restore requires a fresh prepared workspace')
        if value['archiveBytes'] > maximum or value['fileBytes'] > maximum or shutil.disk_usage(ROOT).free < value['fileBytes']:
            raise RuntimeError('Restore byte limit or free disk is insufficient')
        parts = value['parts']
        if not parts or any(part['path'] != f'part-{index:06d}' or not 0 < part['bytes'] <= CHUNK_BYTES for index, part in enumerate(parts)) or sum(part['bytes'] for part in parts) != value['archiveBytes']:
            raise RuntimeError('Invalid chunk manifest')
        if mode == 'restore-inspect':
            staged = sum((directory / part['path']).stat().st_size for part in parts if (directory / part['path']).is_file())
            needed = max(0, value['archiveBytes'] - staged) + value['fileBytes']
            if shutil.disk_usage(ROOT).free < needed:
                raise RuntimeError('Insufficient guest space for remaining archive chunks and extracted database')
            print(json.dumps({'ready': True, 'requiredFreeBytes': needed, 'writerSha256': value['writerSha256']})); return
        for part in parts:
            path = directory / part['path']
            if path.is_symlink() or path.stat().st_size != part['bytes'] or sha(path) != part['sha256']:
                raise RuntimeError('Dataset chunk changed')
        staging = ROOT / 'restore.partial'
        staging.mkdir(exist_ok=False)
        total = 0; names = set()
        with tarfile.open(fileobj=Joined(directory, parts), mode='r|') as archive:
            for member in archive:
                path = pathlib.PurePosixPath(member.name)
                if not member.isfile() or path.is_absolute() or '..' in path.parts or member.name in names or not (member.name in ['snapshot.json', 'manifest.json'] or path.parts[0] == 'execution'):
                    raise RuntimeError('Unexpected dataset archive member')
                names.add(member.name); total += member.size
                if total > value['fileBytes'] or len(names) > value['fileCount']:
                    raise RuntimeError('Archive exceeds its declared contents')
                target = staging / member.name; target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as file:
                    shutil.copyfileobj(archive.extractfile(member), file)
        if total != value['fileBytes'] or len(names) != value['fileCount'] or sha(staging / 'manifest.json') != value['manifestSha256']:
            raise RuntimeError('Restored dataset identity mismatch')
        snapshot = read(staging / 'snapshot.json')
        if snapshot.get('chainId') != 1 or snapshot.get('storageVersion') != 2 or snapshot.get('manifestSha256') != value['manifestSha256'] or snapshot.get('importer', {}).get('sha256') != value['writerSha256'] or not (staging / 'execution' / 'reth.toml').is_file():
            raise RuntimeError('Restored snapshot metadata differs')
        (staging / 'execution').rename(ROOT / 'execution')
        (staging / 'manifest.json').rename(ROOT / 'manifest.json')
        (staging / 'snapshot.json').rename(ROOT / 'snapshot.json')
        write(ROOT / 'restored.json', {'source': value, 'restoredAt': time.time()})
        print(json.dumps({'restored': True, 'nodesStarted': False, 'identity': value}))


if __name__ == '__main__':
    main()
