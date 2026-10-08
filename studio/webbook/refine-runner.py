"""Re-read original-resolution OCR regions, retaining evidence and uncertainty."""
import argparse
import json
import runpy
from pathlib import Path
import re

TOKEN_PATTERN=r"[\u3400-\u9fff]|[^\W\d_\u3400-\u9fff]+(?:['’][^\W\d_\u3400-\u9fff]+)*|\d+|[^\s]"

def aligned_tokens(text, alignment, box):
    total, groups, columns, _=alignment
    chars=[c for group in groups for c in group];cols=[c for group in columns for c in group]
    if ''.join(chars)!=text or len(chars)!=len(cols) or (cols and max(cols)>=total+1):
        raise ValueError('Invalid OCR character alignment; refusing incorrect text positions')
    x,y,x1,y1=box;centers=[x+(c+.5)/total*(x1-x) for c in cols]
    for match in re.finditer(TOKEN_PATTERN,text):
        a,b=match.start(),match.end()-1
        left=x if a==0 else (centers[a-1]+centers[a])/2
        right=x1 if b==len(cols)-1 else (centers[b]+centers[b+1])/2
        yield match.group(),[max(x,left),y,min(x1,right),y1]

ROOT = Path(__file__).resolve().parents[2]
runpy.run_path(str(Path(__file__).with_name('structure-runner.py')), run_name='cache_settings')
import cv2
import numpy as np

def runs(mask):
    edges=np.diff(np.r_[False, mask, False].astype(int))
    return list(zip(np.where(edges==1)[0],np.where(edges==-1)[0]))

def ink(image):
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    _,binary=cv2.threshold(gray,0,255,cv2.THRESH_BINARY_INV+cv2.THRESH_OTSU)
    if np.mean(binary)>160: binary=255-binary
    return binary>0

def split_region(image, box, text):
    x,y,x1,y1=map(int,box); crop=image[y:y1,x:x1]; h,w=crop.shape[:2]
    if h<3 or w<3:return []
    mask=ink(crop)
    # Split stacked lines only at a substantial blank band, preserving diacritics.
    gaps=runs(mask.sum(axis=1)<max(1,w*.008))
    cuts=[(a+b)//2 for a,b in gaps if b-a>=max(5,h*.075) and a>h*.22 and b<h*.78]
    occupied=mask.sum(axis=1)>=max(1,w*.008)
    def body_height(start,end):
        rows=np.where(occupied[start:end])[0]
        return rows[-1]-rows[0]+1 if len(rows) else 0
    # A detached macron/dot is part of the same letter, not another printed line.
    cuts=[c for c in cuts if min(body_height(0,c),body_height(c,h))>=h*.20]
    if cuts:
        bounds=[0]+cuts+[h]
        return [(int(x),int(y+a),int(x1),int(y+b)) for a,b in zip(bounds,bounds[1:]) if b-a>=h*.2]
    # Printed whitespace provides word boundaries even if the first OCR lost spaces.
    if len(re.findall('[A-Za-z]',text))>=10 and not re.search('[\u3400-\u9fff]',text):
        active=np.where(mask.sum(axis=1)>max(1,w*.008))[0]
        height=(active[-1]-active[0]+1) if len(active) else h
        gaps=runs(mask.sum(axis=0)<max(1,h*.012))
        cuts=[(a+b)//2 for a,b in gaps if b-a>=max(5,height*.19) and a>3 and b<w-3]
        bounds=[0]+cuts+[w]
        return [(int(x+a),int(y),int(x+b),int(y1)) for a,b in zip(bounds,bounds[1:]) if b-a>2]
    return [(x,y,x1,y1)]

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--input',required=True);ap.add_argument('--raw',required=True);ap.add_argument('--output',required=True);args=ap.parse_args()
    image=cv2.imdecode(np.fromfile(args.input,dtype=np.uint8),cv2.IMREAD_COLOR)
    raw=json.loads(Path(args.raw).read_text(encoding='utf-8'));raw=raw.get('res',raw)
    source=raw['overall_ocr_res']; tasks=[]
    for index,(text,box) in enumerate(zip(source['rec_texts'],source['rec_boxes'])):
        for part in split_region(image,box,text):tasks.append((index,part))
    from paddleocr import TextRecognition
    model=TextRecognition(model_name='PP-OCRv5_server_rec',device='cpu',cpu_threads=4,enable_mkldnn=False)
    crops=[image[b[1]:b[3],b[0]:b[2]].copy() for _,b in tasks]
    tokens=[];evidence=[];issues=[]
    for (index,box),result in zip(tasks,model.predict(crops,batch_size=1,return_word_box=True)):
        text,alignment=result['rec_text'];score=float(result['rec_score']);x,y,x1,y1=box
        aligned=list(aligned_tokens(text,alignment,box))
        old=source['rec_texts'][index]
        segment=len(evidence)
        evidence.append({'segment':segment,'sourceRegion':index,'sourceText':old,'text':text,'confidence':score,'box':list(box)})
        suspect=score<.90
        if suspect:issues.append({'kind':'low-confidence','sourceRegion':index,'text':text,'confidence':score,'box':list(box)})
        if not aligned:issues.append({'kind':'empty-recognition','sourceRegion':index,'sourceText':old,'box':list(box)})
        for word,(bx,by,ex,ey) in aligned:
            tokens.append({'text':word,'segment':segment,'confidence':score,'sourceRegion':index,'reviewRequired':suspect,'position':{'x':float(bx/image.shape[1]),'y':float(by/image.shape[0]),'width':float((ex-bx)/image.shape[1]),'height':float((ey-by)/image.shape[0])}})
    # Disagreement is retained, even when the second pass is confident.
    for i,old in enumerate(source['rec_texts']):
        new=''.join(e['text'] for e in evidence if e['sourceRegion']==i)
        compact=lambda s:re.sub(r'\s+','',s).casefold()
        if compact(old)!=compact(new):
            issues.append({'kind':'recognition-disagreement','sourceRegion':i,'sourceText':old,'text':new})
            for t in tokens:
                if t['sourceRegion']==i:t['reviewRequired']=True
    tokens.sort(key=lambda t:(t['position']['y'],t['position']['x']))
    for i,t in enumerate(tokens):t['id']=i
    out={'engine':'PP-StructureV3 + region reread','width':image.shape[1],'height':image.shape[0],'coordinateSpace':'normalized-0-1','lines':tokens,'quality':{'status':'needs-review','coverageVerified':False,'unicodeGrouping':2,'issues':issues,'note':'Повторное распознавание не доказывает отсутствие пропусков.','sourceRegions':len(source['rec_texts']),'tokens':len(tokens)},'evidence':evidence}
    Path(args.output).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'tokens':len(tokens),'issues':len(issues)}),flush=True)

if __name__=='__main__':main()
