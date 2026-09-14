"""Prepare and build the selected Rust workspace; jobs own execution deadlines."""
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile
import tarfile
import time
import urllib.request

# Foundry's locked Solar and vergen dependencies require Rust 1.96.
TOOLCHAIN = '1.96.1'


def prepare_reth(env):
    # Current Reth's default JIT uses llvm-sys 221 and its GMP build needs m4.
    release = platform.freedesktop_os_release()
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '24.04':
        raise RuntimeError('Reth source preparation requires Ubuntu 24.04 for LLVM 22 packages')
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', 'gnupg', 'm4'], env=env, check=True)
    key = urllib.request.urlopen('https://apt.llvm.org/llvm-snapshot.gpg.key', timeout=60).read()
    with tempfile.TemporaryDirectory() as directory:
        keyfile = pathlib.Path(directory) / 'llvm.asc'
        keyfile.write_bytes(key)
        details = subprocess.check_output(['gpg', '--homedir', directory, '--batch', '--with-colons', '--show-keys', str(keyfile)], text=True)
        fingerprint = next(line.split(':')[9] for line in details.splitlines() if line.startswith('fpr:'))
        if fingerprint != '6084F3CF814B57C1CF12EFD515CF4D18AF4F7421':
            raise RuntimeError('LLVM package signing key fingerprint mismatch')
    keyring = pathlib.Path('/usr/share/keyrings/fission-llvm.asc')
    keyring.write_bytes(key)
    keyring.chmod(0o644)
    pathlib.Path('/etc/apt/sources.list.d/fission-llvm.list').write_text(
        'deb [arch=amd64 signed-by=/usr/share/keyrings/fission-llvm.asc] https://apt.llvm.org/noble/ llvm-toolchain-noble-22 main\n')
    subprocess.run(['apt-get', 'update'], env=env, check=True)
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', 'llvm-22-dev', 'libpolly-22-dev'], env=env, check=True)


def environment(source, binaries):
    root = pathlib.Path('/workspace')
    cargo_home = root / '.cargo'
    env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'CARGO_HOME': str(cargo_home),
           'RUSTUP_HOME': str(root / '.rustup'), 'RUSTUP_TOOLCHAIN': TOOLCHAIN,
           'CARGO_TARGET_DIR': str(source / 'target'), 'PATH': f'{cargo_home}/bin:' + os.environ['PATH']}
    if binaries == ['reth']:
        env['LLVM_SYS_221_PREFIX'] = '/usr/lib/llvm-22'
    return env


def sha(path):
    with pathlib.Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def identity(source, binaries, env):
    def output(argv):
        return subprocess.check_output(argv, cwd=source, env=env, text=True).strip()
    changes = output(['git', 'status', '--porcelain'])
    # Native CPU tuning can produce instructions unavailable on a later rental.
    flags = {key: value for key, value in env.items() if key.startswith(('CARGO_', 'RUST', 'CC_', 'CXX_')) or key in
             ['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'LLVM_SYS_221_PREFIX']}
    return {'schemaVersion': 1, 'commit': output(['git', 'rev-parse', 'HEAD']), 'clean': not changes,
            'lockSha256': sha(source / 'Cargo.lock'), 'submodules': output(['git', 'submodule', 'status', '--recursive']),
            'toolchain': output(['/workspace/rustc', '-vV']), 'binaries': binaries, 'profile': 'release',
            'cpuFeatures': sorted(next(line.split(':', 1)[1].split() for line in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('flags'))),
            'os': platform.freedesktop_os_release(), 'architecture': platform.machine(), 'libc': platform.libc_ver(),
            'nativePackages': output(['dpkg-query', '-W', '-f=${Package}=${Version}\n', '*']),
            'flags': flags, 'harnessSha256': sha(__file__)}


def verified_build(root, current):
    record = json.loads((root / 'build.json').read_text())
    if not current['clean'] or record.get('identity') != json.loads(json.dumps(current)):
        raise RuntimeError('Build identity differs from the clean prepared checkout or environment')
    if [pathlib.Path(item['path']).name for item in record['binaries']] != current['binaries']:
        raise RuntimeError('Build binary list differs')
    for item in record['binaries']:
        path = root / pathlib.Path(item['path']).name
        if str(path) != item['path'] or path.is_symlink() or not path.is_file() or sha(path) != item['sha256']:
            raise RuntimeError('Compiled artifact changed: ' + str(path))
    return record


def cache(mode, arguments):
    root = pathlib.Path('/workspace')
    prepared = json.loads((root / 'source.json').read_text())
    source = root / 'source'
    binaries = prepared['binaries']
    current = identity(source, binaries, environment(source, binaries))
    if not current['clean']:
        raise RuntimeError('Reusable builds require a clean checkout')
    archive = pathlib.Path(arguments[0])
    maximum = int(arguments[-1])
    if maximum <= 0:
        raise ValueError('Set a positive byte limit')
    if mode == 'cache-save':
        record = verified_build(root, current)
        paths = [root / name for name in [*binaries, 'build.json']]
        total = sum(path.stat().st_size for path in paths)
        if total > maximum:
            raise RuntimeError('Uncompressed build artifacts exceed the byte limit')
        # Exclusive destination preserves an ambiguous earlier export.
        with archive.open('xb') as output:
            with tarfile.open(fileobj=output, mode='w:gz', compresslevel=1) as bundle:
                for path in paths:
                    bundle.add(path, arcname=path.name, recursive=False)
        verified_build(root, current)
        if archive.stat().st_size > maximum:
            raise RuntimeError('Archive exceeds the byte limit')
        print(json.dumps({'schemaVersion': 1, 'sha256': sha(archive), 'bytes': archive.stat().st_size,
                          'uncompressedBytes': total, 'identity': current, 'createdAt': time.time()}))
    else:
        expected = arguments[1]
        if archive.stat().st_size > maximum or sha(archive) != expected:
            raise RuntimeError('Cache archive size or digest mismatch')
        if (root / 'build.json').exists():
            raise RuntimeError('A build is already recorded; preserve it instead of replacing it')
        with tempfile.TemporaryDirectory(dir=root) as directory, tarfile.open(archive, 'r:gz') as bundle:
            staging = pathlib.Path(directory)
            members = []
            expanded = 0
            for member in bundle:
                members.append(member)
                expanded += member.size
                if len(members) > len(binaries) + 1 or expanded > maximum:
                    raise RuntimeError('Cache exceeds its member or uncompressed size limit')
            if sorted(member.name for member in members) != sorted([*binaries, 'build.json']) or any(not member.isfile() for member in members):
                raise RuntimeError('Cache must contain exactly the selected regular binaries and build record')
            if sum(member.size for member in members) > maximum:
                raise RuntimeError('Uncompressed cache exceeds the byte limit')
            for member in members:
                with (staging / member.name).open('xb') as output:
                    shutil.copyfileobj(bundle.extractfile(member), output)
            record = json.loads((staging / 'build.json').read_text())
            if record.get('identity') != json.loads(json.dumps(current)) or [pathlib.Path(item['path']).name for item in record['binaries']] != binaries:
                raise RuntimeError('Cache belongs to a different source, harness, toolchain, flags, or platform')
            for item in record['binaries']:
                name = pathlib.Path(item['path']).name
                if item['path'] != str(root / name) or sha(staging / name) != item['sha256']:
                    raise RuntimeError('Cached binary digest mismatch')
            # Validate everything before publishing any executable. The build record
            # is the final commit marker; interruption never claims a complete restore.
            for name in binaries:
                (staging / name).chmod(0o700)
                (staging / name).replace(root / name)
            record['restored'] = {'archiveSha256': expected, 'at': time.time()}
            (staging / 'build.json').write_text(json.dumps(record, indent=2) + '\n')
            (staging / 'build.json').replace(root / 'build.json')
        print(json.dumps({'ready': True, 'restored': record['restored'], 'identity': current}))


def main():
    root = pathlib.Path('/workspace')
    mode, *binaries = sys.argv[1:]
    if mode in ['cache-save', 'cache-restore']:
        cache(mode, binaries)
        return
    if mode not in ['prepare', 'build', 'verify']:
        raise ValueError('Use prepare or build')
    if mode == 'build':
        (root / 'build.json').unlink(missing_ok=True)
    source = pathlib.Path.cwd() if mode == 'build' else root / 'source'
    if binaries not in [['forge', 'cast', 'anvil', 'chisel'], ['reth'], ['tempo']]:
        raise ValueError('Select the Foundry, Reth or Tempo source recipe')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('The source harness requires Linux x86_64')
    if not (source / 'Cargo.lock').is_file():
        raise RuntimeError('The pinned checkout must include Cargo.lock')
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    cargo_home = root / '.cargo'
    env = environment(source, binaries)
    if mode == 'verify':
        record = verified_build(root, identity(source, binaries, env))
        print(json.dumps({'ready': True, 'build': record}))
        return
    if mode == 'build':
        before = identity(source, binaries, env)
        command = [str(cargo_home / 'bin' / 'cargo'), 'build', '--locked', '--release']
        for binary in binaries:
            command.extend(['--bin', binary])
        subprocess.run(command, cwd=source, env=env, check=True)
        if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != commit:
            raise RuntimeError('Checkout changed during the build; no successful build record was written')
        outputs = []
        for binary in binaries:
            destination = root / binary
            # Replace the inode so a running node may keep its old executable.
            with tempfile.NamedTemporaryFile(dir=root, prefix=f'.{binary}-', delete=False) as file:
                staging = pathlib.Path(file.name)
            try:
                shutil.copy2(source / 'target' / 'release' / binary, staging)
                staging.replace(destination)
            finally:
                staging.unlink(missing_ok=True)
            version = subprocess.check_output([str(destination), '--version'], text=True).strip()
            with destination.open('rb') as file:
                checksum = hashlib.file_digest(file, 'sha256').hexdigest()
            outputs.append({'path': str(destination), 'sha256': checksum, 'version': version})
        after = identity(source, binaries, env)
        if after != before:
            raise RuntimeError('Build environment changed during compilation')
        report = {'identity': after, 'source': str(source), 'commit': commit, 'toolchain': TOOLCHAIN, 'profile': 'release', 'binaries': outputs,
                  'changes': subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)}
        (root / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)
        return
    subprocess.run(['apt-get', 'update'], env=env, check=True)
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends',
                    'build-essential', 'clang', 'libclang-dev', 'pkg-config',
                    'libssl-dev', 'cmake', 'protobuf-compiler', 'ca-certificates'], env=env, check=True)
    if binaries == ['reth']:
        prepare_reth(env)
    # Pin the installer and compiler independently of future upstream defaults.
    url = 'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init'
    data = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c':
        raise RuntimeError('Rust installer digest mismatch')
    installer = root / 'rustup-init'
    installer.write_bytes(data)
    installer.chmod(0o700)
    subprocess.run([str(installer), '-y', '--no-modify-path', '--profile', 'minimal',
                    '--default-toolchain', TOOLCHAIN], env=env, check=True)
    installer.unlink()
    # Subsequent agent jobs can use absolute paths without shell activation.
    for name in ['cargo', 'rustc', 'rustup']:
        wrapper = root / name
        wrapper.write_text(f'#!/bin/sh\nexport CARGO_HOME=/workspace/.cargo RUSTUP_HOME=/workspace/.rustup RUSTUP_TOOLCHAIN={TOOLCHAIN}\nexport PATH="/workspace/.cargo/bin:$PATH"\nexec /workspace/.cargo/bin/' + name + ' "$@"\n')
        wrapper.chmod(0o700)
    build = root / 'build'
    build.write_text('#!/bin/sh\ncd /workspace/source || exit\nexec python3 /workspace/.fission/rust-source.py build ' + ' '.join(binaries) + '\n')
    build.chmod(0o700)
    report = {'identity': identity(source, binaries, env), 'commit': commit, 'toolchain': TOOLCHAIN, 'build': ['/workspace/build'], 'binaries': binaries, 'compiled': False}
    (root / 'source.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
