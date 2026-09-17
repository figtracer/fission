"""Content-addressed release-binary cache namespace on a Fission VPS."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import uuid


ROOT = pathlib.Path('/workspace/.fission/cache-host-v1')
BUILDS = ROOT / 'builds'
STAGING = ROOT / 'staging'
MARKER = ROOT / 'host.json'
IDENTIFIER = re.compile(r'^[a-f0-9]{64}$')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def marker(remote_id=None):
    value = json.loads(MARKER.read_text())
    if value != {'schemaVersion': 1, 'kind': 'fission-build-cache', 'remoteId': remote_id or value.get('remoteId')}:
        raise RuntimeError('Cache host marker or machine identity differs')
    return value


def validate(record, folder, verify_digest=False, expected_id=None):
    archive = folder / 'build.tar.gz'
    expected_id = expected_id or folder.name
    if not folder.is_dir() or folder.is_symlink() or not archive.is_file() or archive.is_symlink():
        raise RuntimeError('Cache object is not a regular directory and archive')
    if record.get('schemaVersion') != 1 or record.get('id') != expected_id or not IDENTIFIER.fullmatch(expected_id):
        raise RuntimeError('Cache object identity is invalid')
    size = archive.stat().st_size
    if record.get('bytes') != size or not isinstance(record.get('uncompressedBytes'), int) or record['uncompressedBytes'] <= 0:
        raise RuntimeError('Cache object sizes differ')
    if verify_digest and digest(archive) != expected_id:
        raise RuntimeError('Cache object digest differs')
    return record


def initialize(remote_id):
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    BUILDS.mkdir(mode=0o700, exist_ok=True)
    STAGING.mkdir(mode=0o700, exist_ok=True)
    value = {'schemaVersion': 1, 'kind': 'fission-build-cache', 'remoteId': remote_id}
    if MARKER.exists():
        if json.loads(MARKER.read_text()) != value:
            raise RuntimeError('Existing cache namespace belongs to another machine identity')
    else:
        temporary = ROOT / f'.host-{uuid.uuid4().hex}'
        temporary.write_text(json.dumps(value) + '\n')
        os.chmod(temporary, 0o600)
        os.link(temporary, MARKER)
        temporary.unlink()
    print(json.dumps({**value, 'root': str(ROOT), 'availableBytes': shutil.disk_usage(ROOT).free}))


def list_objects(remote_id):
    marker(remote_id)
    records = []
    for folder in sorted(BUILDS.iterdir()):
        if not IDENTIFIER.fullmatch(folder.name):
            continue
        metadata = folder / 'cache.json'
        if not metadata.is_file() or metadata.is_symlink() or metadata.stat().st_size > 65536:
            continue
        try:
            records.append(validate(json.loads(metadata.read_text()), folder))
        except (OSError, ValueError, RuntimeError):
            continue
        if len(records) > 1000:
            raise RuntimeError('Cache host contains more than 1000 readable objects')
    print(json.dumps({'schemaVersion': 1, 'records': records, 'availableBytes': shutil.disk_usage(ROOT).free}))


def publish(remote_id, staging, raw_record):
    marker(remote_id)
    source = pathlib.Path(staging)
    if source.parent != STAGING or not source.is_file() or source.is_symlink():
        raise RuntimeError('Publication requires a regular cache-host staging archive')
    record = json.loads(raw_record)
    identifier = record.get('id')
    if not IDENTIFIER.fullmatch(identifier or '') or record.get('bytes') != source.stat().st_size or digest(source) != identifier:
        raise RuntimeError('Staging archive differs from publication metadata')
    final = BUILDS / identifier
    if final.exists():
        metadata = final / 'cache.json'
        if not metadata.is_file() or metadata.stat().st_size > 65536:
            raise RuntimeError('Existing cache object is incomplete')
        existing = validate(json.loads(metadata.read_text()), final, verify_digest=True)
        if existing.get('identity') != record.get('identity') or existing.get('uncompressedBytes') != record.get('uncompressedBytes'):
            raise RuntimeError('Existing cache object metadata differs')
        source.unlink()
        print(json.dumps({'id': identifier, 'bytes': existing['bytes'], 'alreadyPresent': True}))
        return
    temporary = BUILDS / f'.partial-{uuid.uuid4().hex}'
    temporary.mkdir(mode=0o700)
    try:
        os.rename(source, temporary / 'build.tar.gz')
        metadata = temporary / 'cache.json'
        metadata.write_text(json.dumps(record, sort_keys=True) + '\n')
        os.chmod(metadata, 0o600)
        validate(record, temporary, verify_digest=True, expected_id=identifier)
        os.rename(temporary, final)
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary)
        raise
    print(json.dumps({'id': identifier, 'bytes': record['bytes'], 'alreadyPresent': False}))


def main():
    mode, *arguments = sys.argv[1:]
    if mode == 'init' and len(arguments) == 1:
        initialize(arguments[0])
    elif mode == 'list' and len(arguments) == 1:
        list_objects(arguments[0])
    elif mode == 'publish' and len(arguments) == 3:
        publish(*arguments)
    else:
        raise ValueError('Use init REMOTE_ID, list REMOTE_ID, or publish REMOTE_ID STAGING RECORD')


if __name__ == '__main__':
    main()
