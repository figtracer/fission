"""Run bounded, named observations and emit a single readiness result."""
import datetime
import json
import os
import signal
import subprocess
import sys
import tempfile
import time

spec = json.loads(sys.argv[1])
results = []
for check in spec['checks']:
    result = {'name': check['name'], 'ready': False, 'observed': None}
    process = None
    try:
        remaining = spec['deadline'] - time.time()
        if remaining <= 0:
            raise TimeoutError('Readiness deadline reached')
        # Probe output is evidence, not an unbounded job log. Keep the final 64 KiB.
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen(check['argv'], stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                code = process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise TimeoutError('Readiness probe timed out')
            output = []
            for stream in (stdout, stderr):
                stream.seek(0, 2)
                size = stream.tell()
                stream.seek(max(0, size - 65536))
                output.append(stream.read().decode('utf-8', errors='replace'))
            result.update({'exitCode': code, 'stderr': output[1]})
            if check['result'] == 'json':
                result['observed'] = json.loads(output[0])
                result['ready'] = code == 0 and result['observed'].get('ready') is True
            else:
                result['observed'] = output[0]
                result['ready'] = code == 0
    except Exception as error:
        result['error'] = str(error)
    results.append(result)
value = {'schemaVersion': 1, 'scope': spec['scope'], 'ready': bool(results) and all(item['ready'] for item in results),
         'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': results}
print(json.dumps(value))
sys.exit(0 if value['ready'] else 1)
