"""Project-local launcher for the official PaddleOCR MCP package."""
import contextlib
import functools
import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
runpy.run_path(str(ROOT / 'studio' / 'webbook' / 'structure-runner.py'), run_name='cache_settings')
import truststore
truststore.inject_into_ssl()
import paddleocr_mcp.inference.pp_structurev3.local as local

# Public pipeline CPU settings; keep model startup messages out of MCP stdout.
local.PPStructureV3 = functools.partial(local.PPStructureV3, cpu_threads=4, enable_mkldnn=False)
start = local.PPStructureV3LocalInference.start
async def quiet_start(self):
    with contextlib.redirect_stdout(sys.stderr):
        await start(self)
local.PPStructureV3LocalInference.start = quiet_start
predict = local.PPStructureV3LocalInference.predict
async def quiet_predict(self, request):
    with contextlib.redirect_stdout(sys.stderr):
        return await predict(self, request)
local.PPStructureV3LocalInference.predict = quiet_predict
sys.argv = ['paddleocr_mcp', '--model', 'PP-StructureV3', '--ppocr_source', 'local',
            '--device', 'cpu', '--pipeline_config', str(ROOT / '.local' / 'structure-config.yaml')]
runpy.run_module('paddleocr_mcp', run_name='__main__')
