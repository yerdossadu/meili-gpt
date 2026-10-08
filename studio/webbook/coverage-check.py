"""Find unassigned printed components; this is a heuristic, not a coverage proof."""
import argparse,json,re,runpy
from pathlib import Path
import cv2
import numpy as np

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--raw',required=True);p.add_argument('--result',required=True);a=p.parse_args()
    image=cv2.imdecode(np.fromfile(a.input,dtype=np.uint8),1);h,w=image.shape[:2]
    raw=json.loads(Path(a.raw).read_text(encoding='utf-8'));raw=raw.get('res',raw)
    result=json.loads(Path(a.result).read_text(encoding='utf-8'))
    if not result['quality'].get('phoneticEvidenceApplied'):
        runpy.run_path(str(Path(__file__).with_name('phonetic-evidence.py')))['enrich'](image,raw,result)
        result['quality']['phoneticEvidenceApplied']=True
    if not result['quality'].get('unicodeGrouping'):Path(a.result+'.raw-tokens.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
    result['quality']['issues']=[i for i in result['quality']['issues'] if i['kind']!='unassigned-print']
    eligible=np.zeros((h,w),np.uint8);covered=np.zeros((h,w),np.uint8)
    for block in raw.get('parsing_res_list',[]):
        if block.get('block_label') in ('text','table','header','footer','paragraph_title'):
            x,y,x1,y1=map(int,block['block_bbox']);eligible[max(y,0):min(y1,h),max(x,0):min(x1,w)]=1
    for token in result['lines']:
        b=token['position'];x=int(b['x']*w);y=int(b['y']*h);x1=int((b['x']+b['width'])*w);y1=int((b['y']+b['height'])*h)
        covered[max(0,y-3):min(h,y1+3),max(0,x-3):min(w,x1+3)]=1
    # Requiring every channel to be dark avoids treating textured red panels as ink.
    dark=(image.max(axis=2)<145).astype(np.uint8)*eligible
    count,labels,stats,_=cv2.connectedComponentsWithStats(dark,8)
    gaps=[]
    for i in range(1,count):
        x,y,bw,bh,area=map(int,stats[i])
        if not (3<=bw<=w*.025 and 2<=bh<=h*.025 and 12<=area<=w*h*.0004):continue
        pixels=labels[y:y+bh,x:x+bw]==i
        coverage=float(covered[y:y+bh,x:x+bw][pixels].mean())
        if coverage<.2:gaps.append({'kind':'unassigned-print','box':[x,y,x+bw,y+bh],'position':{'x':x/w,'y':y/h,'width':bw/w,'height':bh/h},'note':'Печатный элемент без текста: возможен пропуск или графика.'})
    result['quality']['issues'].extend(gaps);result['quality']['unassignedComponents']=len(gaps)
    result['quality']['coverageMethod']='dark connected components inside recognized text/table blocks; illustrations excluded; not exhaustive'
    result['lines'].sort(key=lambda t:(t['position']['y'],t['position']['x']))
    for i,token in enumerate(result['lines']):token['id']=i
    result['quality']['tokens']=len(result['lines'])
    Path(a.result).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'unassignedComponents':len(gaps)}))

if __name__=='__main__':main()
