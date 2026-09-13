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
import urllib.request


def main():
    root = pathlib.Path('/workspace')
    mode, *binaries = sys.argv[1:]
    if mode not in ['prepare', 'build']:
        raise ValueError('Use prepare or build')
    if mode == 'build':
        (root / 'build.json').unlink(missing_ok=True)
    source = root / 'source' if mode == 'prepare' else pathlib.Path.cwd()
    if binaries not in [['forge', 'cast', 'anvil', 'chisel'], ['reth'], ['tempo']]:
        raise ValueError('Select the Foundry, Reth or Tempo source recipe')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise RuntimeError('The source harness requires Linux x86_64')
    if not (source / 'Cargo.lock').is_file():
        raise RuntimeError('The pinned checkout must include Cargo.lock')
    commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    cargo_home = root / '.cargo'
    env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'CARGO_HOME': str(cargo_home),
           'RUSTUP_HOME': str(root / '.rustup'), 'RUSTUP_TOOLCHAIN': '1.95.0',
           'CARGO_TARGET_DIR': str(source / 'target'), 'PATH': f'{cargo_home}/bin:' + os.environ['PATH']}
    if mode == 'build':
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
        report = {'source': str(source), 'commit': commit, 'toolchain': '1.95.0', 'profile': 'release', 'binaries': outputs,
                  'changes': subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True)}
        (root / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)
        return
    subprocess.run(['apt-get', 'update'], env=env, check=True)
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends',
                    'build-essential', 'clang', 'libclang-dev', 'pkg-config',
                    'libssl-dev', 'cmake', 'protobuf-compiler', 'ca-certificates'], env=env, check=True)
    # Pin the installer and compiler independently of future upstream defaults.
    url = 'https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init'
    data = urllib.request.urlopen(url, timeout=120).read()
    if hashlib.sha256(data).hexdigest() != '20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c':
        raise RuntimeError('Rust installer digest mismatch')
    installer = root / 'rustup-init'
    installer.write_bytes(data)
    installer.chmod(0o700)
    subprocess.run([str(installer), '-y', '--no-modify-path', '--profile', 'minimal',
                    '--default-toolchain', '1.95.0'], env=env, check=True)
    installer.unlink()
    # Subsequent agent jobs can use absolute paths without shell activation.
    for name in ['cargo', 'rustc', 'rustup']:
        wrapper = root / name
        wrapper.write_text('#!/bin/sh\nexport CARGO_HOME=/workspace/.cargo RUSTUP_HOME=/workspace/.rustup RUSTUP_TOOLCHAIN=1.95.0\nexport PATH="/workspace/.cargo/bin:$PATH"\nexec /workspace/.cargo/bin/' + name + ' "$@"\n')
        wrapper.chmod(0o700)
    build = root / 'build'
    build.write_text('#!/bin/sh\ncd /workspace/source || exit\nexec python3 /workspace/.fission/rust-source.py build ' + ' '.join(binaries) + '\n')
    build.chmod(0o700)
    report = {'commit': commit, 'toolchain': '1.95.0', 'build': ['/workspace/build'], 'binaries': binaries, 'compiled': False}
    (root / 'source.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
