"""Read-only Base execution, rollup-consensus and operator L1 readiness probe."""
import argparse
import json
import time
import urllib.request

BASE_GENESIS = '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd'

parser = argparse.ArgumentParser()
parser.add_argument('--execution', default='http://127.0.0.1:8545')
parser.add_argument('--rollup', default='http://127.0.0.1:9545')
parser.add_argument('--l1-execution-url', required=True)
parser.add_argument('--l1-beacon-url', required=True)
parser.add_argument('--max-head-age', required=True, type=int)
parser.add_argument('--max-safe-age', required=True, type=int)
parser.add_argument('--max-l1-head-age', required=True, type=int)
parser.add_argument('--max-l1-lag-blocks', required=True, type=int)
parser.add_argument('--max-tip-lag-blocks', required=True, type=int)
parser.add_argument('--chain-id', type=int, default=8453)
parser.add_argument('--l1-chain-id', type=int, default=1)
parser.add_argument('--genesis-hash', default=BASE_GENESIS)
parser.add_argument('--dependencies-only', action='store_true')
args = parser.parse_args()


def get(url):
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


def rpc(url, method, params=None):
    request = urllib.request.Request(url, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or []}).encode(), headers={'Content-Type': 'application/json'})
    value = get(request)
    if 'error' in value or 'result' not in value:
        raise ValueError(f'RPC failed: {method}: {json.dumps(value.get("error", "missing result"))}')
    return value['result']


def number(value):
    return int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value)


def block_matches(reference, block):
    return block is not None and number(block['number']) == number(reference['number']) and block['hash'].lower() == reference['hash'].lower()


try:
    now = time.time()
    l1_head = rpc(args.l1_execution_url, 'eth_getBlockByNumber', ['latest', False])
    beacon_spec = get(args.l1_beacon_url.rstrip('/') + '/eth/v1/config/spec')['data']
    get(args.l1_beacon_url.rstrip('/') + '/eth/v1/beacon/headers/head')
    get(args.l1_beacon_url.rstrip('/') + '/eth/v1/beacon/blob_sidecars/head')
    checks = {
        'l1Chain': number(rpc(args.l1_execution_url, 'eth_chainId')) == args.l1_chain_id,
        'l1Fresh': 0 <= now - number(l1_head['timestamp']) <= args.max_l1_head_age,
        'l1BeaconNetwork': number(beacon_spec['DEPOSIT_CHAIN_ID']) == args.l1_chain_id,
        'l1BeaconData': True,
    }
    if args.dependencies_only:
        ready = all(checks.values())
        print(json.dumps({'ready': ready, 'checks': checks, 'l1Block': number(l1_head['number'])}))
        raise SystemExit(0 if ready else 1)

    latest = rpc(args.execution, 'eth_getBlockByNumber', ['latest', False])
    sync = rpc(args.rollup, 'optimism_syncStatus')
    config = rpc(args.rollup, 'optimism_rollupConfig')
    peers = rpc(args.rollup, 'opp2p_peerCount')
    unsafe, safe, finalized = sync['unsafe_l2'], sync['safe_l2'], sync['finalized_l2']
    unsafe_block = rpc(args.execution, 'eth_getBlockByNumber', [hex(number(unsafe['number'])), False])
    safe_block = rpc(args.execution, 'eth_getBlockByNumber', [hex(number(safe['number'])), False])
    finalized_block = rpc(args.execution, 'eth_getBlockByNumber', [hex(number(finalized['number'])), False])
    output = rpc(args.rollup, 'optimism_outputAtBlock', [hex(number(safe['number']))])
    l1_current = number(sync['current_l1']['number'])
    checks.update({
        'baseChain': number(rpc(args.execution, 'eth_chainId')) == args.chain_id,
        'baseGenesis': config['genesis']['l2']['hash'].lower() == args.genesis_hash.lower(),
        'rollupChains': number(config['l1_chain_id']) == args.l1_chain_id and number(config['l2_chain_id']) == args.chain_id,
        'executionPeers': number(rpc(args.execution, 'net_peerCount')) > 0,
        'rollupPeers': number(peers['connectedGossip']) > 0,
        'executionSynced': rpc(args.execution, 'eth_syncing') is False,
        'headFresh': 0 <= now - number(latest['timestamp']) <= args.max_head_age,
        'safeFresh': 0 <= now - number(safe['timestamp']) <= args.max_safe_age,
        'headCoherent': block_matches(unsafe, unsafe_block) and block_matches(unsafe, latest),
        'safeCoherent': block_matches(safe, safe_block),
        'finalizedCoherent': block_matches(finalized, finalized_block),
        'ordered': 0 < number(finalized['number']) <= number(safe['number']) <= number(unsafe['number']),
        'tipLag': 0 <= number(latest['number']) - number(unsafe['number']) <= args.max_tip_lag_blocks,
        'l1Derivation': l1_current > 0 and 0 <= number(l1_head['number']) - l1_current <= args.max_l1_lag_blocks,
        'outputPath': block_matches(output['blockRef'], safe_block) and output['stateRoot'].lower() == safe_block['stateRoot'].lower(),
    })
    ready = all(checks.values())
    print(json.dumps({'ready': ready, 'checks': checks, 'base': {'unsafe': unsafe, 'safe': safe, 'finalized': finalized},
                      'l1': {'head': number(l1_head['number']), 'current': l1_current}, 'peers': peers}))
    raise SystemExit(0 if ready else 1)
except Exception as error:
    print(json.dumps({'ready': False, 'error': str(error)}))
    raise SystemExit(1)
