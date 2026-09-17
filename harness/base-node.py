"""Import a pinned Base snapshot and control one unified execution/rollup node."""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path('/workspace/base-data')
TOOLS = pathlib.Path('/workspace/.fission/clients')
BASE = TOOLS / 'base-1.4.0'
OBSERVER = pathlib.Path('/workspace/.fission/base-ready.py')
BASEUP_URL = 'https://raw.githubusercontent.com/base/base/6767cc7cb11e43046014d405600d8d3c253abf70/baseup/baseup'
BASEUP_SHA256 = 'c1993a0566ad9ceefb964c738fc47bdbbe42c641f0bbfa6e253ed80f75523ed5'
ARCHIVE_SHA256 = '6ad5de47da6ea5f533a91fdc43177f79b4f666f4393059378ce32225a04b70ef'
SIGNING_FINGERPRINT = '5EFE7BCFCD85682711F9FC30904841FFEBD38BAD'


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


def output(argv, **options):
    return subprocess.check_output([str(arg) for arg in argv], text=True, **options).strip()


def public_origin(value, name):
    url = urllib.parse.urlparse(value)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.port or url.path not in ['', '/'] or url.query or url.fragment:
        raise RuntimeError(name + ' must be a credential-free HTTPS origin persisted in task state')
    return value


def install():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or not pathlib.Path('/run/systemd/system').is_dir():
        raise RuntimeError('Base synced mode requires a Linux x86_64 VM running systemd')
    ROOT.mkdir(exist_ok=True)
    TOOLS.mkdir(parents=True, exist_ok=True)
    subprocess.run(['apt-get', 'update'], check=True)
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', 'ca-certificates', 'curl', 'gnupg', 'tar'], check=True)
    script = urllib.request.urlopen(BASEUP_URL, timeout=60).read()
    if hashlib.sha256(script).hexdigest() != BASEUP_SHA256:
        raise RuntimeError('Pinned Base release installer changed')
    with tempfile.NamedTemporaryFile() as file:
        file.write(script)
        file.flush()
        env = {**os.environ, 'BASE_BIN_DIR': str(TOOLS), 'BASEUP_HOME': str(ROOT / 'installer')}
        subprocess.run(['bash', file.name, '--install', 'v1.4.0', '--bin', 'base'], env=env, check=True)
    installed = TOOLS / 'base'
    installed.replace(BASE)
    BASE.chmod(0o500)
    version = output([BASE, '--version'])
    if version != 'base 1.4.0':
        raise RuntimeError('Installed Base binary has an unexpected version')
    wrapper = pathlib.Path('/workspace/base-node')
    wrapper.write_text('#!/bin/sh\nexec python3 /workspace/.fission/base-node.py "$@"\n')
    wrapper.chmod(0o700)
    write(pathlib.Path('/workspace/base-tools.json'), {'prepared': True, 'binary': {'path': str(BASE), 'sha256': digest(BASE), 'version': version},
          'release': {'tag': 'v1.4.0', 'commit': '6767cc7cb11e43046014d405600d8d3c253abf70', 'archiveSha256': ARCHIVE_SHA256,
                      'installerSha256': BASEUP_SHA256, 'gpgFingerprint': SIGNING_FINGERPRINT, 'signatureVerified': True},
          'snapshotImported': False, 'nodeStarted': False})


def download(args):
    if (ROOT / 'snapshot-attempt.json').exists() or (ROOT / 'execution').exists():
        raise RuntimeError('Base snapshot preparation already recorded; preserve it rather than replaying import')
    tools = read(pathlib.Path('/workspace/base-tools.json'))
    if digest(BASE) != tools['binary']['sha256']:
        raise RuntimeError('Pinned Base binary changed')
    raw = pathlib.Path(args.manifest).read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.sha256:
        raise RuntimeError('Manifest differs from the pre-quote sizing record')
    manifest = json.loads(raw)
    if manifest.get('chain_id') != 8453 or manifest.get('storage_version') != 2 or manifest.get('block', 0) <= 0:
        raise RuntimeError('Expected a Base mainnet V2 snapshot manifest')
    source = urllib.parse.urlparse(args.manifest_url)
    if source.scheme != 'https' or source.hostname != 'mainnet-v2-snapshots.base.org' or not re.fullmatch(r'/\d+/manifest\.json', source.path) or source.username or source.password or source.port or source.query or source.fragment:
        raise RuntimeError('Expected the immutable official Base manifest URL')
    saved = ROOT / 'manifest.json'
    with saved.open('xb') as file:
        file.write(raw)
    staging = ROOT / 'execution.partial'
    command = [BASE, 'snapshot', 'download', '--chain', 'base', '--full', '--manifest-path', saved,
               '--datadir', staging, '--non-interactive', '--logs.stdout.quiet']
    canonical = json.loads(output([*command, '--print-plan-json']))
    planned = read(pathlib.Path(args.plan))
    if canonical != planned:
        raise RuntimeError('Canonical Base full plan differs from the pre-quote sizing input; download was not started')
    required = canonical['totalDownloadSize'] + canonical['totalOutputSize'] + args.extra_disk_gib * 2**30
    available = shutil.disk_usage(ROOT).free
    if available < required:
        raise RuntimeError(f'Insufficient free space for Base snapshot: required {required} bytes, available {available} bytes')
    record = {'manifestSha256': args.sha256, 'manifestUrl': args.manifest_url, 'block': canonical['block'], 'chainId': 8453,
              'selection': 'full', 'storageVersion': 2, 'extraDiskGiB': args.extra_disk_gib, 'requiredFreeBytes': required,
              'binary': tools['binary'], 'startedAt': time.time()}
    write(ROOT / 'snapshot-attempt.json', record)
    subprocess.run([*map(str, command), '--resumable', 'true'], check=True)
    if not (staging / 'reth.toml').is_file():
        raise RuntimeError('Base snapshot import did not write its node configuration')
    staging.rename(ROOT / 'execution')
    write(ROOT / 'snapshot.json', {**record, 'completedAt': time.time()})


def unit_state(unit):
    observed = subprocess.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,ControlGroup,InvocationID'], capture_output=True, text=True)
    value = dict(line.split('=', 1) for line in observed.stdout.splitlines() if '=' in line)
    if observed.returncode and value.get('LoadState') != 'not-found':
        raise RuntimeError('Could not observe the recorded Base systemd unit')
    return value


def stop():
    current = ROOT / 'current.json'
    if not current.exists():
        return
    attempt = read(current)
    subprocess.run(['systemctl', 'stop', attempt['unit']], check=False)
    state = unit_state(attempt['unit'])
    if state.get('LoadState') != 'not-found' and (state.get('ActiveState') not in ['inactive', 'failed'] or state.get('MainPID') != '0' or state.get('ControlPID') != '0'):
        raise RuntimeError('Base node stop is unconfirmed')
    write(current, {**attempt, 'phase': 'stopped', 'stoppedAt': time.time(), 'observation': state})


def probe_args(args):
    return [OBSERVER, '--l1-execution-url', args.l1_execution_url, '--l1-beacon-url', args.l1_beacon_url,
            '--max-head-age', args.max_head_age, '--max-safe-age', args.max_safe_age, '--max-l1-head-age', args.max_l1_head_age,
            '--max-l1-lag-blocks', args.max_l1_lag_blocks, '--max-tip-lag-blocks', args.max_tip_lag_blocks]


def start(args):
    current = ROOT / 'current.json'
    if current.exists():
        raise RuntimeError('Base startup already recorded; observe or explicitly stop it rather than replaying')
    snapshot = read(ROOT / 'snapshot.json')
    if digest(BASE) != snapshot['binary']['sha256'] or not (ROOT / 'execution' / 'reth.toml').is_file():
        raise RuntimeError('Completed Base snapshot and pinned binary are required')
    public_origin(args.l1_execution_url, 'L1 execution URL')
    public_origin(args.l1_beacon_url, 'L1 beacon URL')
    subprocess.run(['python3', *map(str, probe_args(args)), '--dependencies-only'], check=True)
    attempt_id = str(uuid.uuid4())
    unit = 'fission-base-' + attempt_id
    command = [BASE, '--chain', 'mainnet', 'rpc', '--datadir', ROOT / 'execution', '--http', '--http.addr', '127.0.0.1',
               '--http.port', '8545', '--http.api', 'eth,net,web3', '--port', '30303', '--discovery.port', '30303',
               '--rpc.addr', '127.0.0.1', '--rpc.port', '9545', '--p2p.listen.tcp', '9222', '--p2p.listen.udp', '9223',
               '--l1-eth-rpc', args.l1_execution_url, '--l1-beacon', args.l1_beacon_url]
    attempt = {'id': attempt_id, 'phase': 'startup_unknown', 'startedAt': time.time(), 'unit': unit,
               'command': [str(item) for item in command], 'environment': {'BASE_NODE_L1_TRUST_RPC': 'false'},
               'snapshot': snapshot, 'bounds': vars(args)}
    (ROOT / 'starts').mkdir(exist_ok=True)
    write(ROOT / 'starts' / (attempt_id + '.json'), attempt)
    write(current, attempt)
    subprocess.run(['systemd-run', '--unit', unit, '--property=Restart=no', '--property=KillMode=control-group',
                    '--property=TimeoutStopSec=60', '--property=WorkingDirectory=/workspace', '--setenv=BASE_NODE_L1_TRUST_RPC=false',
                    *map(str, command)], check=True)
    write(current, {**attempt, 'phase': 'started', 'observation': unit_state(unit)})
    return attempt_id


def observe(args):
    current = ROOT / 'current.json'
    if not current.exists():
        return {'ready': False, 'phase': 'not_started'}
    attempt = read(current)
    before = unit_state(attempt['unit'])
    result = {'ready': False, 'attempt': attempt['id'], 'phase': attempt['phase'], 'unit': before, 'observedAt': time.time()}
    if before.get('ActiveState') == 'active':
        probe = subprocess.run(['python3', *map(str, probe_args(args))], capture_output=True, text=True)
        result['readiness'] = json.loads(probe.stdout)
        after = unit_state(attempt['unit'])
        latest = read(current)
        stable = latest['id'] == attempt['id'] and latest['phase'] != 'stopped' and after.get('ActiveState') == 'active' and after.get('InvocationID') == before.get('InvocationID')
        result.update(unit=after, ready=stable and probe.returncode == 0 and result['readiness'].get('ready') is True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('install')
    get = actions.add_parser('download')
    get.add_argument('--manifest', required=True); get.add_argument('--manifest-url', required=True)
    get.add_argument('--sha256', required=True); get.add_argument('--plan', required=True)
    get.add_argument('--extra-disk-gib', required=True, type=int)
    for name in ['start', 'status', 'wait']:
        sub = actions.add_parser(name)
        sub.add_argument('--l1-execution-url', required=True); sub.add_argument('--l1-beacon-url', required=True)
        sub.add_argument('--max-head-age', required=True, type=int); sub.add_argument('--max-safe-age', required=True, type=int)
        sub.add_argument('--max-l1-head-age', required=True, type=int); sub.add_argument('--max-l1-lag-blocks', required=True, type=int)
        sub.add_argument('--max-tip-lag-blocks', required=True, type=int)
    actions.add_parser('stop')
    args = parser.parse_args()
    if args.action == 'install': install(); return
    if args.action == 'download' and (args.extra_disk_gib <= 0 or not len(args.sha256) == 64): parser.error('Invalid snapshot bounds')
    if args.action in ['start', 'status', 'wait'] and (min(args.max_head_age, args.max_safe_age, args.max_l1_head_age) <= 0 or min(args.max_l1_lag_blocks, args.max_tip_lag_blocks) < 0): parser.error('Invalid readiness bounds')
    expected = None
    if args.action not in ['status', 'wait']:
        with (ROOT / 'mutation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'download': download(args)
            elif args.action == 'stop': stop()
            else: expected = start(args)
    if args.action in ['start', 'status', 'wait']:
        first = None
        while True:
            result = observe(args)
            print(json.dumps(result), flush=True)
            if args.action == 'status': return
            expected = expected or result.get('attempt')
            if result.get('attempt') != expected or result.get('phase') in ['not_started', 'stopped']:
                raise RuntimeError('Base node invocation changed or stopped while waiting')
            if result['unit'].get('ActiveState') == 'failed':
                raise RuntimeError('Base node service failed')
            if result['ready']:
                current = result['readiness']
                progress = (current['base']['unsafe']['number'], current['base']['safe']['number'], current['l1']['current'])
                if first and int(progress[0]) > int(first[0]) and (int(progress[1]) > int(first[1]) or int(progress[2]) > int(first[2])):
                    return
                first = progress
            else:
                first = None
            time.sleep(6)


if __name__ == '__main__':
    main()
