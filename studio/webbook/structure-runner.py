"""Local PP-StructureV3 conversion; no page-specific coordinates or text fixes."""
import argparse
import json
import os
import sys
import tempfile
import faulthandler
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / '.local' / 'structure-models'
TMP = ROOT / '.local' / 'structure-tmp'
CACHE.mkdir(parents=True, exist_ok=True)
TMP.mkdir(parents=True, exist_ok=True)
os.environ['PADDLE_PDX_CACHE_HOME'] = str(CACHE)
os.environ['PADDLE_HOME'] = str(CACHE / 'paddle')
os.environ['HF_HOME'] = str(CACHE / 'huggingface')
os.environ['PADDLE_PDX_MODEL_SOURCE'] = 'bos'
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
os.environ['TEMP'] = str(TMP)
os.environ['TMP'] = str(TMP)
os.environ['OMP_NUM_THREADS'] = '4'
os.environ['OPENBLAS_NUM_THREADS'] = '4'
tempfile.tempdir = str(TMP)
faulthandler.enable()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    import truststore
    truststore.inject_into_ssl()
    from paddleocr import PPStructureV3
    pipeline = PPStructureV3(
        device='cpu', cpu_threads=4, enable_mkldnn=False,
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False, use_formula_recognition=False,
        use_seal_recognition=False, use_chart_recognition=False,
        use_table_recognition=True,
        text_det_limit_side_len=1600, text_det_limit_type='max',
    )
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    pipeline.export_paddlex_config_to_yaml(str(ROOT / '.local' / 'structure-config.yaml'))
    print('Recognition started', flush=True)
    for result in pipeline.predict_iter(args.input):
        result.save_to_json(str(output))
        result.save_to_markdown(str(output))
    print(json.dumps({'output': str(output)}))

if __name__ == '__main__':
    main()
