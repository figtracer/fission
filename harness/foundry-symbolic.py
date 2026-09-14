"""Install the pinned external solver for the prebuilt Foundry symbolic engine."""
import hashlib
import io
import json
import pathlib
import platform
import subprocess
import urllib.request
import zipfile


def main():
    libc, version = platform.libc_ver()
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or libc != 'glibc' or tuple(map(int, version.split('.'))) < (2, 39):
        raise RuntimeError('The symbolic recipe requires Linux x86_64 with glibc >= 2.39 (Ubuntu 24.04)')
    root = pathlib.Path('/workspace')
    url = 'https://github.com/Z3Prover/z3/releases/download/z3-5.1.0/z3-5.1.0-x64-glibc-2.39.zip'
    expected = 'f47be8d27d3230e823bf1eeede2fe0abaca55bb78d0b59974370e6689a92284a'
    data = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError('Z3 archive digest mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        binary = archive.read('z3-5.1.0-x64-glibc-2.39/bin/z3')
    solver = root / 'z3'
    solver.write_bytes(binary)
    solver.chmod(0o700)
    solver_version = subprocess.check_output([str(solver), '--version'], text=True, timeout=30).strip()
    forge_version = subprocess.check_output([str(root / 'forge'), '--version'], text=True, timeout=30).strip()
    help_text = subprocess.check_output([str(root / 'forge'), 'test', '--help'], text=True, timeout=30)
    if '--symbolic' not in help_text:
        raise RuntimeError('Installed Forge does not expose symbolic execution')
    record = {'solver': solver_version, 'forge': forge_version, 'solverPath': str(solver),
              'url': url, 'archiveSha256': expected, 'binarySha256': hashlib.sha256(binary).hexdigest()}
    (root / 'symbolic-tools.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record))


if __name__ == '__main__':
    main()
