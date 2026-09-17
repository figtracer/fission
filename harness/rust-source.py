"""Prepare and build the selected Rust workspace; jobs own execution deadlines."""
import hashlib
import errno
import fcntl
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
UBUNTU_SNAPSHOT = '20260917T000000Z'
IDENTITY_CHECK = 'build-identity-check.json'
DIAGNOSTIC_VALUE_BYTES = 2048
DIAGNOSTIC_STATUS_BYTES = 4096


def apt_idle():
    states = subprocess.check_output([
        'systemctl', 'show', 'apt-daily.service', 'apt-daily-upgrade.service',
        '--property=ActiveState', '--value'], text=True)
    states = [state for state in states.splitlines() if state]
    jobs = subprocess.check_output([
        'systemctl', 'list-jobs', '--no-legend', 'apt-daily.service', 'apt-daily-upgrade.service'], text=True).strip()
    if len(states) != 2 or any(state not in ['inactive', 'failed'] for state in states) or jobs:
        return False, {'states': states, 'jobs': jobs}
    descriptors = []
    try:
        for path in ['/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock', '/var/lib/apt/lists/lock',
                     '/var/cache/apt/archives/lock']:
            try:
                descriptor = os.open(path, os.O_RDWR)
            except FileNotFoundError:
                continue
            descriptors.append(descriptor)
            try:
                fcntl.lockf(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in [errno.EACCES, errno.EAGAIN]:
                    return False, {'states': states, 'jobs': jobs, 'lock': path}
                raise
        return True, {'states': states, 'jobs': jobs}
    finally:
        for descriptor in descriptors:
            os.close(descriptor)


def wait_for_apt(seconds=600):
    deadline = time.monotonic() + seconds
    details = None
    while time.monotonic() < deadline:
        idle, details = apt_idle()
        if idle:
            return
        time.sleep(2)
    raise RuntimeError(f'APT did not become idle within {seconds}s: {details}')


def prepare_packages(snapshot=UBUNTU_SNAPSHOT):
    subprocess.run(['systemctl', 'mask', 'apt-daily.service', 'apt-daily-upgrade.service'], check=True)
    subprocess.run(['systemctl', 'mask', '--now', 'apt-daily.timer', 'apt-daily-upgrade.timer'], check=True)
    wait_for_apt()
    env = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_SUSPEND': '1'}
    common = ['apt-get', '-S', snapshot]
    policy = ['-o', 'DPkg::Lock::Timeout=600', '-o', 'APT::Get::Always-Include-Phased-Updates=true',
              '-o', 'APT::Get::Never-Include-Phased-Updates=false', '-o', 'Dpkg::Options::=--force-confdef',
              '-o', 'Dpkg::Options::=--force-confold', '--no-install-recommends', '--no-remove', '-y']
    subprocess.run([*common, '-o', 'APT::Update::Error-Mode=any', 'update'], env=env, check=True)
    subprocess.run([*common, *policy, 'dist-upgrade'], env=env, check=True)
    subprocess.run([*common, *policy, 'install', 'git', 'ca-certificates', 'build-essential', 'clang',
                    'libclang-dev', 'pkg-config', 'libssl-dev', 'cmake', 'protobuf-compiler'], env=env, check=True)
    subprocess.run(['apt-get', '-o', 'DPkg::Lock::Timeout=600', 'check'], env=env, check=True)
    audit = subprocess.check_output(['dpkg', '--audit'], env=env, text=True)
    if audit.strip():
        raise RuntimeError('dpkg audit reported incomplete package state: ' + audit[:2048])
    wait_for_apt()
    print(json.dumps({'packagesPrepared': True, 'snapshot': snapshot}), flush=True)


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


def atomic_json(path, value):
    path = pathlib.Path(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', dir=path.parent, prefix=f'.{path.name}-', delete=False) as file:
            temporary = pathlib.Path(file.name)
            json.dump(value, file, indent=2, sort_keys=True)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def identity_value(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    result = {'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest()}
    if len(encoded) <= DIAGNOSTIC_VALUE_BYTES:
        result['value'] = value
    else:
        result.update(preview=encoded[:DIAGNOSTIC_VALUE_BYTES].decode(errors='replace'), truncated=True)
    return result


def changed_lines(before, after):
    old, new = set(str(before).splitlines()), set(str(after).splitlines())
    return {
        'removed': [line[:256] for line in sorted(old - new)[:16]],
        'added': [line[:256] for line in sorted(new - old)[:16]],
        'removedCount': len(old - new),
        'addedCount': len(new - old),
    }


def verify_stable_build(root, source, before, after):
    changed = sorted(key for key in before.keys() | after.keys() if before.get(key) != after.get(key))
    record = {
        'schemaVersion': 1,
        'status': 'matched' if not changed else 'mismatch',
        'changedFields': changed,
        'beforeSha256': identity_value(before)['sha256'],
        'afterSha256': identity_value(after)['sha256'],
    }
    if changed:
        record['fields'] = {}
        for key in changed:
            values = {'before': identity_value(before.get(key)), 'after': identity_value(after.get(key))}
            if isinstance(before.get(key), str) and isinstance(after.get(key), str) and ('\n' in before[key] or '\n' in after[key]):
                values['changedLines'] = changed_lines(before[key], after[key])
            record['fields'][key] = values
        try:
            status = subprocess.check_output(['git', 'status', '--porcelain', '--ignore-submodules=none'],
                                             cwd=source, text=True)
            status_error = None
        except (OSError, subprocess.SubprocessError) as error:
            status, status_error = '', f'{type(error).__name__}: {error}'[:512]
        encoded = status.encode()
        record['gitStatus'] = {'bytes': len(encoded), 'sha256': hashlib.sha256(encoded).hexdigest(),
                               'preview': encoded[:DIAGNOSTIC_STATUS_BYTES].decode(errors='replace'),
                               'truncated': len(encoded) > DIAGNOSTIC_STATUS_BYTES}
        if status_error:
            record['gitStatus']['error'] = status_error
    atomic_json(pathlib.Path(root) / IDENTITY_CHECK, record)
    if changed:
        raise RuntimeError('Build environment changed during compilation; changed fields: ' + ', '.join(changed))
    return record


def working_tree(source, env):
    # Git owns file modes, binary content, symlinks and ignore rules. A scratch
    # index hashes the actual build inputs without modifying the user's index.
    # Gitlinks capture commits, not dirty files inside submodules. Refuse those
    # inputs rather than assigning different builds the same identity.
    if subprocess.check_output(['git', 'submodule', 'foreach', '--recursive', '--quiet',
                                'git status --porcelain --ignore-submodules=none'],
                               cwd=source, env=env, text=True).strip():
        raise RuntimeError('Submodule worktrees must be clean; build identity records their commits')
    with tempfile.TemporaryDirectory() as scratch:
        env = {**env, 'GIT_INDEX_FILE': str(pathlib.Path(scratch) / 'index')}
        subprocess.run(['git', 'read-tree', 'HEAD'], cwd=source, env=env, check=True)
        subprocess.run(['git', 'add', '-A'], cwd=source, env=env, check=True)
        return subprocess.check_output(['git', 'write-tree'], cwd=source, env=env, text=True).strip()


def apply_patch(source, patch, expected):
    if sha(patch) != expected:
        raise RuntimeError('Patch differs from the planned input')
    if subprocess.check_output(['git', 'status', '--porcelain', '--ignore-submodules=none'], cwd=source):
        raise RuntimeError('Apply a patch only to the pristine pinned checkout')
    subprocess.run(['git', 'apply', '--whitespace=nowarn', str(patch)], cwd=source, check=True)


def identity(source, binaries, env):
    def output(argv):
        return subprocess.check_output(argv, cwd=source, env=env, text=True).strip()
    changes = output(['git', 'status', '--porcelain', '--ignore-submodules=none'])
    # Native CPU tuning can produce instructions unavailable on a later rental.
    flags = {key: value for key, value in env.items() if key.startswith(('CARGO_', 'RUST', 'CC_', 'CXX_')) or key in
             ['CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'LLVM_SYS_221_PREFIX']}
    return {'schemaVersion': 1, 'commit': output(['git', 'rev-parse', 'HEAD']), 'clean': not changes,
            'tree': working_tree(source, env),
            'lockSha256': sha(source / 'Cargo.lock'), 'submodules': output(['git', 'submodule', 'status', '--recursive']),
            'toolchain': output(['/workspace/rustc', '-vV']), 'binaries': binaries, 'profile': 'release',
            'cpuFeatures': sorted(next(line.split(':', 1)[1].split() for line in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('flags'))),
            'os': platform.freedesktop_os_release(), 'architecture': platform.machine(), 'libc': platform.libc_ver(),
            'nativePackages': output(['dpkg-query', '-W', '-f=${Package}=${Version}\n', '*']),
            'flags': flags, 'harnessSha256': sha(__file__)}


def verified_build(root, current):
    record = json.loads((root / 'build.json').read_text())
    if record.get('identity') != json.loads(json.dumps(current)):
        raise RuntimeError('Build identity differs from the prepared source tree or environment')
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
            if record.get('identity') != json.loads(json.dumps(current)):
                if mode == 'cache-reuse':
                    result = {'restored': False, 'reason': 'Exact source/toolchain/CPU/packages/flags identity differs; cold build required'}
                    (root / 'cache-result.json').write_text(json.dumps(result) + '\n')
                    print(json.dumps(result))
                    return
                raise RuntimeError('Cache belongs to a different source, harness, toolchain, flags, or platform')
            if [pathlib.Path(item['path']).name for item in record['binaries']] != binaries:
                raise RuntimeError('Cached binary list differs')
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
        result = {'ready': True, 'restored': record['restored'], 'identity': current}
        if mode == 'cache-reuse':
            (root / 'cache-result.json').write_text(json.dumps(result) + '\n')
        print(json.dumps(result))


def main():
    root = pathlib.Path('/workspace')
    mode, *binaries = sys.argv[1:]
    if mode == 'prepare-packages':
        prepare_packages()
        return
    if mode == 'apply':
        patch, expected = binaries
        apply_patch(root / 'source', pathlib.Path(patch), expected)
        record = json.loads((root / 'source.json').read_text())
        record['patchSha256'] = expected
        record['identity'] = identity(root / 'source', record['binaries'], environment(root / 'source', record['binaries']))
        (root / 'source.json').write_text(json.dumps(record, indent=2) + '\n')
        return
    if mode in ['cache-save', 'cache-restore', 'cache-reuse']:
        cache(mode, binaries)
        return
    if mode not in ['prepare', 'build', 'ensure-build', 'verify', 'verify-source']:
        raise ValueError('Use prepare, build, ensure-build, verify or verify-source')
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
    if mode == 'verify-source':
        record = json.loads((root / 'source.json').read_text())
        if record['identity'] != json.loads(json.dumps(identity(source, binaries, env))):
            raise RuntimeError('Source identity changed after preparation/patch; tests refused')
        print(json.dumps({'ready': True, 'source': record}))
        return
    if mode == 'verify':
        record = verified_build(root, identity(source, binaries, env))
        print(json.dumps({'ready': True, 'build': record}))
        return
    if mode == 'ensure-build' and (root / 'build.json').exists():
        record = verified_build(root, identity(source, binaries, env))
        print(json.dumps({'ready': True, 'compiled': False, 'build': record}))
        return
    if mode in ['build', 'ensure-build']:
        atomic_json(root / IDENTITY_CHECK, {'schemaVersion': 1, 'status': 'not_checked', 'changedFields': []})
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
        verify_stable_build(root, source, before, after)
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
        native = 'export LLVM_SYS_221_PREFIX=/usr/lib/llvm-22\n' if binaries == ['reth'] else ''
        wrapper.write_text(f'#!/bin/sh\nexport CARGO_HOME=/workspace/.cargo RUSTUP_HOME=/workspace/.rustup RUSTUP_TOOLCHAIN={TOOLCHAIN}\nexport CARGO_TARGET_DIR=/workspace/source/target\nexport PATH="/workspace/.cargo/bin:$PATH"\n' + native + 'exec /workspace/.cargo/bin/' + name + ' "$@"\n')
        wrapper.chmod(0o700)
    build = root / 'build'
    build.write_text('#!/bin/sh\ncd /workspace/source || exit\nexec python3 /workspace/.fission/rust-source.py build ' + ' '.join(binaries) + '\n')
    build.chmod(0o700)
    report = {'identity': identity(source, binaries, env), 'commit': commit, 'toolchain': TOOLCHAIN, 'build': ['/workspace/build'], 'binaries': binaries, 'compiled': False}
    (root / 'source.json').write_text(json.dumps(report, indent=2) + '\n')
    atomic_json(root / IDENTITY_CHECK, {'schemaVersion': 1, 'status': 'not_checked', 'changedFields': []})
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
