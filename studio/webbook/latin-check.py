"""Second-model check of uncertain Latin fragments; preserve disagreement evidence."""
import argparse,json,runpy,unicodedata
from pathlib import Path
import cv2
import numpy as np

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--result',required=True);a=p.parse_args()
    helpers=runpy.run_path(str(Path(__file__).with_name('refine-runner.py')),run_name='helpers')
    r=json.loads(Path(a.result).read_text(encoding='utf-8'));image=cv2.imdecode(np.fromfile(a.input,dtype=np.uint8),1)
    candidates=[e for e in r['evidence'] if e['confidence']<.95 and e['text'] and not any(ord(c)>127 and unicodedata.category(c).startswith('L') for c in e['text'])]
    if candidates:
        from paddleocr import TextRecognition
        model=TextRecognition(model_name='en_PP-OCRv5_mobile_rec',device='cpu',cpu_threads=4,enable_mkldnn=False)
        for e in candidates:
            x,y,x1,y1=e['box']
            out=next(iter(model.predict(image[y:y1,x:x1],batch_size=1,return_word_box=True)))
            text,alignment=out['rec_text'];score=float(out['rec_score'])
            e['latinAlternative']={'text':text,'confidence':score}
            if text and text!=e['text'] and score>=.90 and score>e['confidence']+.10:
                previous=e['text'];e['previousText']=previous;e['text']=text;e['confidence']=score
                r['lines']=[t for t in r['lines'] if t.get('segment')!=e['segment']]
                for word,(bx,by,ex,ey) in helpers['aligned_tokens'](text,alignment,e['box']):
                    r['lines'].append({'text':word,'segment':e['segment'],'sourceRegion':e['sourceRegion'],'confidence':score,'reviewRequired':True,'recognizer':'en_PP-OCRv5_mobile_rec','position':{'x':bx/r['width'],'y':by/r['height'],'width':(ex-bx)/r['width'],'height':(ey-by)/r['height']}})
                r['quality']['issues'].append({'kind':'engine-disagreement','sourceRegion':e['sourceRegion'],'sourceText':previous,'text':text,'box':e['box']})
    r['quality']['latinChecked']=len(candidates)
    Path(a.result).write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'latinChecked':len(candidates)}),flush=True)

if __name__=='__main__':main()
