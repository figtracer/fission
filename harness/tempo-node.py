"""Run a configured Tempo client under the managed task's existing lifetime."""
import argparse
import json
import pathlib
import subprocess
import time
import urllib.request
import uuid
from node_options import options

ROOT = pathlib.Path('/workspace/tempo-data')
BINARY = pathlib.Path('/workspace/tempo')


def write(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def observe():
    config = options(ROOT)
    current = json.loads((ROOT / 'current.json').read_text())
    def service():
        result = subprocess.check_output(['systemctl', 'show', current['unit'], '--property=ActiveState,InvocationID'], text=True)
        return dict(line.split('=', 1) for line in result.splitlines() if '=' in line)
    before = service()
    result = {'ready': False, 'unit': before, 'role': config['role'], 'observedAt': time.time()}
    if before.get('ActiveState') != 'active':
        return result
    def rpc(method, params):
        request = urllib.request.Request('http://127.0.0.1:8645', data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(), headers={'Content-Type':'application/json'})
        value = json.load(urllib.request.urlopen(request, timeout=5))
        if 'error' in value:
            raise RuntimeError(str(value['error']))
        return value['result']
    try:
        chain = int(rpc('eth_chainId', []), 16)
        head = rpc('eth_getBlockByNumber', ['latest', False])
        syncing = rpc('eth_syncing', [])
        age = time.time() - int(head['timestamp'], 16)
        after = service()
        checks = {'chain': chain == config['chainId'], 'stableProcess': before == after,
                  'synced': syncing is False, 'freshHead': config['role'] == 'dev' or 0 <= age <= config['maxHeadAge']}
        result.update(ready=all(checks.values()), checks=checks, chainId=chain, block=int(head['number'],16), headAge=age)
    except Exception as error:
        result['error'] = str(error)
    return result


def start():
    config = options(ROOT)
    current = ROOT / 'current.json'
    if current.exists():
        raise RuntimeError('Tempo startup already recorded; observe the same unit rather than replaying')
    argv = [str(BINARY), 'node', '--datadir', str(ROOT / 'chain'), '--http', '--http.addr', '127.0.0.1', '--http.port', '8645',
            '--http.api', ','.join(dict.fromkeys(['eth','net','web3',*config.get('rpcModules',[])])), '--authrpc.addr', '127.0.0.1', '--authrpc.port', '8651', '--ipcdisable', '--port', '30313']
    if config['role'] == 'dev':
        argv += ['--dev', '--dev.block-time', '1s']
        if config.get('network') and config['network'] != 'dev':
            argv += ['--chain', config['network']]
    else:
        argv += ['--chain', config['network']]
        if config['role'] == 'rpc':
            argv += ['--follow'] + ([config['upstream']] if config.get('upstream') else [])
    if config.get('retention') in ['minimal', 'full']:
        argv += ['--' + config['retention']]
    argv += config.get('args', [])
    unit = 'fission-tempo-' + str(uuid.uuid4())
    write(current, {'unit': unit, 'command': argv, 'phase': 'startup_unknown', 'startedAt': time.time()})
    subprocess.run(['systemd-run', '--unit', unit, '--property=Restart=no', '--property=KillMode=control-group',
                    '--property=TimeoutStopSec=60', '--property=WorkingDirectory=/workspace', *argv], check=True)
    first = None
    while True:
        result = observe()
        print(json.dumps(result), flush=True)
        if result['unit'].get('ActiveState') == 'failed':
            raise RuntimeError('Tempo service failed')
        if result['ready']:
            sample = (result['unit'].get('InvocationID'), result['block'])
            if config['role'] == 'dev' or first is not None and sample[0] == first[0] and sample[1] > first[1]:
                return
            if first is None or sample[0] != first[0]:
                first = sample
        else:
            first = None
        time.sleep(5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'start', 'status'])
    parser.add_argument('--options', default='{}')
    args = parser.parse_args()
    if args.action == 'install':
        ROOT.mkdir(exist_ok=True)
        config = {'role':'dev','network':'dev','chainId':1337, **json.loads(args.options)}
        write(ROOT / 'node-options.json', config)
        version = subprocess.check_output([str(BINARY),'--version'],text=True,timeout=30).strip()
        write(pathlib.Path('/workspace/tempo-tools.json'), {'version':version,'configuration':config})
        wrapper = pathlib.Path('/workspace/tempo-node')
        wrapper.write_text('#!/bin/sh\nexec python3 /workspace/.fission/tempo-node.py "$@"\n')
        wrapper.chmod(0o700)
    elif args.action == 'start':
        start()
    else:
        print(json.dumps(observe()))


if __name__ == '__main__':
    main()
