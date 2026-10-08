"""Run a learner-only Railway mirror using a persistent volume."""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

root = Path('/app')
data = Path(os.environ.get('CHAO_DATA_DIR', '/var/data'))
seed = root / 'seed'
# Refresh the read-only lesson mirror on each deploy. Learner feedback and TTS
# cache live in separate volume paths and are preserved.
shutil.copytree(seed / 'forma', data / 'forma', dirs_exist_ok=True)
shutil.copy2(seed / 'library.sqlite3', data / 'library.sqlite3')
shutil.copytree(seed / 'tts', data / 'tts', dirs_exist_ok=True)

env = os.environ.copy()
env['CHAO_DATA_DIR'] = str(data)
platform = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', '8011'],
    cwd=root / 'study', env=env)
gateway = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'testing_gateway:app', '--host', '0.0.0.0', '--port', os.environ.get('PORT', '8080')],
    cwd=root / 'study', env=env)
try:
    while gateway.poll() is None:
        if platform.poll() is not None:
            raise RuntimeError(f'Internal study process exited with code {platform.returncode}')
        time.sleep(1)
finally:
    gateway.terminate()
    platform.terminate()
    for child in (gateway, platform):
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
