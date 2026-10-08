"""Inspect framed-card caption bands independently of the first layout OCR."""
import json,argparse,runpy,re
from pathlib import Path
import cv2,numpy as np

def missing_caption_components(image,raw,result):
    frames=runpy.run_path(str(Path(__file__).with_name('css-rebuild.py')))['framed_regions']
    h,w=image.shape[:2];covered=np.zeros((h,w),np.uint8);regions=[]
    for t in result['lines']:
        p=t['position'];x=int(p['x']*w);y=int(p['y']*h);x1=int((p['x']+p['width'])*w);y1=int((p['y']+p['height'])*h)
        covered[max(0,y-3):min(h,y1+3),max(0,x-3):min(w,x1+3)]=1
    for block in raw.get('parsing_res_list',[]):
        if block['block_label']!='image':continue
        for x,y,x1,y1 in frames(image,block['block_bbox']):
            fh=y1-y;fw=x1-x;top=y+int(fh*.67)
            dark=(image[top:y1,x:x1].max(axis=2)<145).astype(np.uint8)
            count,labels,stats,_=cv2.connectedComponentsWithStats(dark,8)
            for k,(a,b,c,d,area) in enumerate(stats[1:],1):
                if not(.02*fw<c<.45*fw and .035*fh<d<.25*fh and area>30):continue
                pixels=labels[b:b+d,a:a+c]==k
                overlap=covered[top+b:top+b+d,x+a:x+a+c][pixels].mean()
                if overlap<.1:regions.append([max(x,x+a-12),max(top,top+b-12),min(x1,x+a+c+12),min(y1,top+b+d+12)])
    return regions

def main():
    p=argparse.ArgumentParser()
    for key in ['input','raw','result']:p.add_argument('--'+key,required=True)
    a=p.parse_args();helpers=runpy.run_path(str(Path(__file__).with_name('refine-runner.py')),run_name='helpers')
    r=json.loads(Path(a.result).read_text(encoding='utf-8'));raw=json.loads(Path(a.raw).read_text(encoding='utf-8'));raw=raw.get('res',raw)
    image=cv2.imread(a.input);regions=missing_caption_components(image,raw,r);evidence=[]
    if regions:
        from paddleocr import TextRecognition
        model=TextRecognition(model_name='PP-OCRv5_server_rec',device='cpu',cpu_threads=4,enable_mkldnn=False)
        for box in regions:
            x,y,x1,y1=box;crop=image[y:y1,x:x1];reads=[]
            for scale in [1,2]:
                sample=crop if scale==1 else cv2.resize(crop,None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC)
                output=next(iter(model.predict(sample,batch_size=1,return_word_box=True)));text,alignment=output['rec_text'];reads.append((text,float(output['rec_score']),alignment))
            first,second=reads
            accepted=first[0]==second[0] and min(first[1],second[1])>=.9 and bool(re.fullmatch(r'[\u3400-\u9fff]',first[0]))
            evidence.append({'box':box,'reads':[{'text':t,'confidence':s} for t,s,_ in reads],'accepted':accepted})
            if accepted:
                for text,(bx,by,ex,ey) in helpers['aligned_tokens'](first[0],first[2],box):
                    r['lines'].append({'text':text,'confidence':min(first[1],second[1]),'reviewRequired':True,'recognizer':'caption-residual-two-scales','position':{'x':bx/r['width'],'y':by/r['height'],'width':(ex-bx)/r['width'],'height':(ey-by)/r['height']}})
            r['quality']['issues'].append({'kind':'recovered-caption' if accepted else 'unresolved-caption-component','box':box,'text':first[0] if accepted else ''})
    r['captionRecovery']=evidence;r['quality']['tokens']=len(r['lines'])
    r['lines'].sort(key=lambda t:(t['position']['y'],t['position']['x']))
    for i,t in enumerate(r['lines']):t['id']=i
    Path(a.result).write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
