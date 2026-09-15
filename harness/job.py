"""Remote job supervisor. No wallet, provider credentials, or model runs here."""
import json
import os
import pathlib
import platform
import shutil
import signal
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
spec = json.loads((root / "spec.json").read_text())
deadline = spec["deadline"]
state = {"id": spec["id"], "phase": "running", "startedAt": time.time(), "step": 0}


class Cancelled(Exception):
    pass


def save():
    temporary = root / "status.tmp"
    with temporary.open("w") as file:
        json.dump(state, file)
        file.flush()
        os.fsync(file.fileno())
    temporary.replace(root / "status.json")


def run(command, log):
    remaining = deadline - time.time()
    if remaining <= 0:
        raise TimeoutError("Job deadline reached")
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                               stderr=log, start_new_session=True, cwd=spec["cwd"])
    state["pid"] = process.pid
    save()
    try:
        while True:
            if (root / 'cancel').exists():
                raise Cancelled('Stop requested')
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError('Job deadline reached')
            try:
                return process.wait(timeout=min(1, remaining))
            except subprocess.TimeoutExpired:
                pass
    except (Cancelled, TimeoutError):
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise


try:
    source = pathlib.Path('/workspace/source')
    environment = {'platform': platform.platform(), 'architecture': platform.machine(), 'cpu': os.cpu_count(),
                   'diskFreeBytes': shutil.disk_usage(spec['cwd']).free, 'source': None}
    if (source / '.git').exists():
        try:
            commit = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True, timeout=5).strip()
            changes = subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True, timeout=5)
            environment['source'] = {'commit': commit, 'clean': not changes, 'changes': changes}
        except Exception as error:
            environment['source'] = {'error': str(error)}
    state['environment'] = environment
    save()
    if spec.get('checks'):
        checks = dict(spec['checks'], deadline=min(deadline, time.time() + 120))
        with (root / 'readiness.json').open('wb') as output:
            code = run(['python3', '-c', spec['checkRunner'], json.dumps(checks)], output)
        state['readiness'] = json.loads((root / 'readiness.json').read_text())
        save()
        if code or state['readiness'].get('ready') is not True:
            raise RuntimeError('Fresh harness readiness failed; workload not executed')
    with (root / "output.log").open("ab", buffering=0) as log:
        for index, command in enumerate(spec["commands"]):
            state.update(phase="running", step=index, stepStartedAt=time.time())
            save()
            code = run(command, log)
            state.setdefault('steps', []).append({'index': index, 'startedAt': state['stepStartedAt'], 'finishedAt': time.time(), 'returncode': code})
            if code:
                state.update(phase="failed", returncode=code)
                break
        else:
            readiness = spec.get("readiness", [])
            while readiness:
                state.update(phase="waiting")
                save()
                results = [run(command, log) for command in readiness]
                state["checks"] = results
                save()
                if all(code == 0 for code in results):
                    break
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError("Readiness deadline reached")
                time.sleep(min(spec["pollSeconds"], remaining))
            state.update(phase="succeeded", returncode=0)
except Cancelled as error:
    state.update(phase="cancelled", error=str(error))
except TimeoutError as error:
    state.update(phase="timed_out", error=str(error))
except Exception as error:
    state.update(phase="failed", error=str(error))
finally:
    state["finishedAt"] = time.time()
    save()
