"""Pinned client assets and options shared by managed node controllers."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import tarfile
import urllib.request


def options(root):
    path = root / 'node-options.json'
    return json.loads(path.read_text()) if path.exists() else {}


def install_client(spec, target):
    data = urllib.request.urlopen(spec['url'], timeout=120).read()
    if hashlib.sha256(data).hexdigest() != spec['sha256']:
        raise RuntimeError('Client archive digest mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        members = [entry for entry in archive.getmembers() if entry.isfile() and pathlib.PurePosixPath(entry.name).name == spec['executable']]
        if len(members) != 1:
            raise RuntimeError('Expected exactly one client executable')
        with target.open('xb') as output:
            output.write(archive.extractfile(members[0]).read())
    target.chmod(0o500)
    version = subprocess.check_output([str(target), '--version'], text=True, timeout=30).strip()
    if not re.search(r'(?<![\d.])' + re.escape(spec['version']) + r'(?![\d.])', version):
        raise RuntimeError('Client version does not match the selected release')
    return {'path': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'version': version, 'asset': spec}
