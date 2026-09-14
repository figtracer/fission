"""Prepare a full mainnet snapshot and explicitly control a lease-lived node pair."""
import argparse
import fcntl
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import secrets
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
import tarfile

ROOT = pathlib.Path('/workspace/ethereum-data')
TOOLS = pathlib.Path('/workspace/.fission/clients')
RETH = TOOLS / 'reth-2.5.2'
LIGHTHOUSE = TOOLS / 'lighthouse-8.2.2'
OBSERVER = pathlib.Path('/workspace/.fission/ethereum-ready.py')


def write(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as file:
        json.dump(value, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(path)


def read(path):
    return json.loads(path.read_text())


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def command(args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def install():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or not pathlib.Path('/run/systemd/system').is_dir():
        raise RuntimeError('This harness requires a Linux x86_64 VM running systemd')
    TOOLS.mkdir(parents=True, exist_ok=True)
    ROOT.mkdir(exist_ok=True)
    assets = [
        (RETH, 'reth', 'https://github.com/paradigmxyz/reth/releases/download/v2.5.2/reth-v2.5.2-x86_64-unknown-linux-gnu.tar.gz', 'e360895ac51b351ff0c44573f0f619bb1e7c3ff2df55502af1190c14c9b5ef6d'),
        (LIGHTHOUSE, 'lighthouse', 'https://github.com/sigp/lighthouse/releases/download/v8.2.2/lighthouse-v8.2.2-x86_64-unknown-linux-gnu.tar.gz', '334922e4b55075fbe86acaef3ce2a8e55699d2c647443e83cffed00f3babfaa8'),
    ]
    binaries = []
    for target, name, url, expected in assets:
        data = urllib.request.urlopen(url, timeout=120).read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise RuntimeError(name + ' archive digest mismatch')
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            members = [member for member in archive.getmembers() if pathlib.PurePosixPath(member.name).name == name and member.isfile()]
            if len(members) != 1:
                raise RuntimeError('Expected one executable: ' + name)
            with target.open('xb') as file:
                shutil.copyfileobj(archive.extractfile(members[0]), file)
        target.chmod(0o500)
        binaries.append({'path': str(target), 'sha256': digest(target), 'version': command([target, '--version'])})
    wrapper = pathlib.Path('/workspace/ethereum')
    with wrapper.open('x') as file:
        file.write('#!/bin/sh\nexec python3 /workspace/.fission/ethereum-node.py "$@"\n')
    wrapper.chmod(0o700)
    write(pathlib.Path('/workspace/ethereum-tools.json'), {'prepared': True, 'binaries': binaries, 'snapshotImported': False, 'nodesStarted': False})


def download(args):
    if (ROOT / 'snapshot-attempt.json').exists() or (ROOT / 'execution').exists():
        raise RuntimeError('Snapshot preparation already recorded. Preserve the staging data; no import is repeated automatically')
    tools = read(pathlib.Path('/workspace/ethereum-tools.json'))
    importer = next(binary for binary in tools['binaries'] if binary['path'] == str(RETH))
    if digest(RETH) != importer['sha256']:
        raise RuntimeError('Pinned snapshot importer changed')
    raw = pathlib.Path(args.manifest).read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.sha256:
        raise RuntimeError('Manifest differs from the pre-quote sizing record')
    manifest = json.loads(raw)
    if manifest.get('chain_id') != 1 or manifest.get('storage_version') != 2 or not str(manifest.get('reth_version', '')).startswith('2.5.2 '):
        raise RuntimeError('Expected an Ethereum mainnet V2 snapshot produced by Reth 2.5.2')
    source = urllib.parse.urlparse(manifest.get('base_url', ''))
    if source.scheme != 'https' or source.hostname != 'snapshots-r2.reth.rs' or source.username or source.password or source.port or source.query or source.fragment:
        raise RuntimeError('Use the official HTTPS Reth snapshot manifest')
    saved_manifest = ROOT / 'manifest.json'
    if saved_manifest.exists():
        if saved_manifest.read_bytes() != raw:
            raise RuntimeError('A different manifest is already staged; preserve it for inspection')
    else:
        with saved_manifest.open('xb') as file:
            file.write(raw)
    staging = ROOT / 'execution.partial'
    if staging.exists():
        raise RuntimeError('Existing snapshot staging requires explicit recovery')
    argv = [RETH, 'download', '--chain', 'mainnet', '--manifest-path', saved_manifest, '--full', '--datadir', staging]
    plan = json.loads(command([*argv, '--print-plan-json', '--quiet']))
    if plan.get('schemaVersion') != 1 or plan.get('chainId') != 1 or plan.get('block') != manifest.get('block') or not plan.get('archives'):
        raise RuntimeError('Invalid canonical snapshot plan')
    urls = [archive['url'] for archive in plan['archives']]
    if len(set(urls)) != len(urls) or any(not url.startswith(manifest['base_url'].rstrip('/') + '/') for url in urls):
        raise RuntimeError('Snapshot archives must be unique and remain under the official manifest base URL')
    for total, key in [('totalDownloadSize', 'downloadSize'), ('totalOutputSize', 'outputSize')]:
        sizes = [archive[key] for archive in plan['archives']]
        if any(type(size) is not int or size < 0 for size in sizes) or sum(sizes) != plan.get(total):
            raise RuntimeError('Snapshot plan sizes are incomplete')
    required = plan['totalDownloadSize'] + plan['totalOutputSize'] + args.extra_disk_gib * 2**30
    available = shutil.disk_usage(ROOT).free
    if available < required:
        raise RuntimeError(f'Insufficient free space for compressed + extracted snapshot and the explicit extra allowance: required {required} bytes, available {available} bytes')
    record = {'manifestSha256': args.sha256, 'block': plan['block'], 'chainId': 1, 'selection': 'full', 'storageVersion': 2,
              'importer': importer, 'extraDiskGiB': args.extra_disk_gib, 'requiredFreeBytes': required, 'startedAt': time.time()}
    write(ROOT / 'snapshot-attempt.json', record)
    subprocess.run([str(arg) for arg in [*argv, '--resumable', '--non-interactive']], check=True)
    if not (staging / 'reth.toml').is_file():
        raise RuntimeError('Snapshot import did not write its node configuration')
    staging.rename(ROOT / 'execution')
    write(ROOT / 'snapshot.json', {**record, 'completedAt': time.time()})


def units(attempt):
    result = {}
    for unit in attempt['units']:
        observed = subprocess.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,InvocationID'], capture_output=True, text=True)
        value = dict(line.split('=', 1) for line in observed.stdout.splitlines() if '=' in line)
        if observed.returncode and value.get('LoadState') != 'not-found':
            raise RuntimeError('Could not observe the recorded systemd unit: ' + unit)
        result[unit] = value
    return result


def stopped(states):
    for state in states.values():
        if state.get('LoadState') == 'not-found':
            continue
        if state.get('ActiveState') not in ['inactive', 'failed'] or state.get('MainPID') != '0' or state.get('ControlPID') != '0':
            return False
        group = state.get('ControlGroup')
        if group:
            processes = pathlib.Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.procs'
            if processes.exists() and processes.read_text().strip():
                return False
    return True


def stop():
    current = ROOT / 'current.json'
    if not current.exists():
        return
    attempt = read(current)
    existing = [unit for unit, state in units(attempt).items() if state.get('LoadState') != 'not-found']
    if existing:
        # A stopped transient unit can disappear before this command reaches it.
        # Only the subsequent process/cgroup observation confirms shutdown.
        subprocess.run(['systemctl', 'stop', *existing], check=False)
    observation = units(attempt)
    if not stopped(observation):
        raise RuntimeError('Node stop is unconfirmed; observe the existing units before restarting')
    write(current, {**attempt, 'phase': 'stopped', 'stoppedAt': time.time(), 'observation': observation})


def start(args):
    current = ROOT / 'current.json'
    if current.exists():
        if args.action != 'restart':
            raise RuntimeError('Node startup already recorded. Use status/wait, or explicit restart')
    snapshot = read(ROOT / 'snapshot.json')
    if not (ROOT / 'execution' / 'reth.toml').is_file():
        raise RuntimeError('A completed snapshot import is required')
    url = urllib.parse.urlparse(args.checkpoint_url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RuntimeError('Select an explicit trusted HTTPS mainnet checkpoint endpoint')
    if not re.fullmatch('0x[a-fA-F0-9]{64}:[0-9]+', args.checkpoint):
        raise RuntimeError('Supply the independently verified checkpoint as block_root:epoch')
    source = pathlib.Path(args.reth).resolve() if args.reth else RETH
    checksum = digest(source)
    if not args.reth and checksum != snapshot['importer']['sha256']:
        raise RuntimeError('Pinned baseline executable changed')
    candidate = TOOLS / ('reth-' + checksum)
    if not candidate.exists():
        with source.open('rb') as incoming, candidate.open('xb') as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        candidate.chmod(0o500)
    if digest(candidate) != checksum:
        raise RuntimeError('Candidate executable changed while being copied')
    jwt = ROOT / 'jwt.hex'
    if not jwt.exists():
        fd = os.open(jwt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            file.write(secrets.token_hex(32))
            file.flush()
            os.fsync(file.fileno())
    if not re.fullmatch('[a-f0-9]{64}', jwt.read_text()):
        raise RuntimeError('Existing Engine API JWT is invalid; preserve the node state for inspection')
    attempt_id = str(uuid.uuid4())
    unit_names = ['fission-reth-' + attempt_id, 'fission-lighthouse-' + attempt_id]
    commands = [
        [str(candidate), 'node', '--chain', 'mainnet', '--full', '--datadir', str(ROOT / 'execution'), '--http', '--http.addr', '127.0.0.1', '--http.api', 'eth,net,web3', '--authrpc.addr', '127.0.0.1', '--authrpc.jwtsecret', str(jwt), '--port', '30303'],
        [str(LIGHTHOUSE), 'bn', '--network', 'mainnet', '--datadir', str(ROOT / 'consensus'), '--execution-endpoint', 'http://127.0.0.1:8551', '--execution-jwt', str(jwt), '--checkpoint-sync-url', args.checkpoint_url, '--wss-checkpoint', args.checkpoint, '--http', '--http-address', '127.0.0.1', '--http-port', '5052', '--port', '9000'],
    ]
    attempt = {'id': attempt_id, 'phase': 'startup_unknown', 'startedAt': time.time(), 'units': unit_names, 'commands': commands,
               'snapshot': snapshot, 'reth': {'path': str(candidate), 'sha256': checksum, 'version': command([candidate, '--version']),
               'compatibility': 'candidate-unverified' if args.reth else 'pinned-baseline'}, 'checkpointUrl': args.checkpoint_url, 'checkpoint': args.checkpoint}
    attempts = ROOT / 'starts'
    attempts.mkdir(exist_ok=True)
    if current.exists():
        stop()
    write(attempts / (attempt_id + '.json'), attempt)
    write(current, attempt)
    for unit, argv in zip(unit_names, commands):
        subprocess.run(['systemd-run', '--unit', unit, '--property=Restart=no', '--property=KillMode=control-group',
                        '--property=TimeoutStopSec=60', '--property=WorkingDirectory=/workspace', *argv], check=True)
    write(current, {**attempt, 'phase': 'started', 'observation': units(attempt)})
    return attempt_id


def observe(max_age):
    current = ROOT / 'current.json'
    if not current.exists():
        return {'ready': False, 'phase': 'not_started'}
    attempt = read(current)
    state = units(attempt)
    active = all(unit.get('ActiveState') == 'active' for unit in state.values())
    result = {'ready': False, 'attempt': attempt['id'], 'phase': attempt['phase'], 'units': state, 'observedAt': time.time()}
    if active:
        probe = subprocess.run(['python3', str(OBSERVER), '--chain-id', '1', '--mainnet-pair', '--max-head-age', str(max_age)], capture_output=True, text=True, check=False)
        result['readiness'] = json.loads(probe.stdout)
        after = units(attempt)
        latest = read(current)
        if latest['id'] != attempt['id']:
            raise RuntimeError('Node invocation changed during the readiness probe; observe the new attempt separately')
        stable = latest['phase'] != 'stopped' and all(value.get('ActiveState') == 'active' and value.get('InvocationID') == state[unit].get('InvocationID') for unit, value in after.items())
        result.update(units=after, phase=latest['phase'], observedAt=time.time())
        result['ready'] = stable and probe.returncode == 0 and result['readiness'].get('ready') is True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('install')
    get = actions.add_parser('download')
    get.add_argument('--manifest', required=True)
    get.add_argument('--sha256', required=True)
    get.add_argument('--extra-disk-gib', required=True, type=int)
    for name in ['start', 'restart', 'status', 'wait']:
        sub = actions.add_parser(name)
        sub.add_argument('--max-head-age', required=True, type=int)
        if name in ['start', 'restart']:
            sub.add_argument('--checkpoint-url', required=True)
            sub.add_argument('--checkpoint', required=True, help='Independently verified mainnet block_root:epoch')
            sub.add_argument('--reth', help='Explicit candidate binary; database compatibility is unverified')
    actions.add_parser('stop')
    args = parser.parse_args()
    if hasattr(args, 'max_head_age') and args.max_head_age <= 0:
        parser.error('--max-head-age must be positive seconds')
    if args.action == 'download' and (args.extra_disk_gib <= 0 or not re.fullmatch('[a-f0-9]{64}', args.sha256)):
        parser.error('Use a positive explicit disk allowance and exact manifest SHA-256')
    if args.action == 'install':
        install()
        return
    expected_attempt = None
    if args.action not in ['status', 'wait']:
        with (ROOT / 'mutation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'download':
                download(args)
            elif args.action == 'stop':
                stop()
            else:
                expected_attempt = start(args)
    if args.action in ['start', 'restart', 'status', 'wait']:
        first_head = None
        while True:
            result = observe(args.max_head_age)
            print(json.dumps(result), flush=True)
            if args.action == 'status':
                return
            if result.get('phase') in ['not_started', 'stopped']:
                raise RuntimeError('No running node attempt to wait for')
            expected_attempt = expected_attempt or result.get('attempt')
            if result.get('attempt') != expected_attempt:
                raise RuntimeError('Node invocation changed while waiting; inspect the new attempt separately')
            if any(unit.get('ActiveState') == 'failed' for unit in result.get('units', {}).values()):
                raise RuntimeError('A node service failed; inspect its journal and explicitly stop/restart')
            if result['ready']:
                head = result['readiness']['pair']['executionBlock']
                if first_head is not None and head > first_head:
                    return
                first_head = head if first_head is None else first_head
            else:
                first_head = None
            time.sleep(15)


if __name__ == '__main__':
    main()
