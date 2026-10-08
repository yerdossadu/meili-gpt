"""Re-read empty quoted spans at two scales; never substitute a known page text."""
import json,argparse,runpy
from pathlib import Path
import cv2

def candidates(result):
    groups={}
    for token in result['lines']:groups.setdefault(token.get('segment'),[]).append(token)
    for tokens in groups.values():
        tokens.sort(key=lambda t:t['position']['x'])
        for left,right in zip(tokens,tokens[1:]):
            if left['text']=='“' and right['text']=='”':yield left,right

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--result',required=True);a=p.parse_args()
    helpers=runpy.run_path(str(Path(__file__).with_name('refine-runner.py')),run_name='helpers')
    r=json.loads(Path(a.result).read_text(encoding='utf-8'));pairs=list(candidates(r));evidence=[]
    if pairs:
        from paddleocr import TextRecognition
        model=TextRecognition(model_name='PP-OCRv5_server_rec',device='cpu',cpu_threads=4,enable_mkldnn=False)
        image=cv2.imread(a.input);w,h=r['width'],r['height']
        for left,right in pairs:
            p,q=left['position'],right['position']
            box=[max(0,int(p['x']*w)-6),max(0,int(min(p['y'],q['y'])*h)-6),min(w,int((q['x']+q['width'])*w)+6),min(h,int(max(p['y']+p['height'],q['y']+q['height'])*h)+6)]
            x,y,x1,y1=box;crop=image[y:y1,x:x1];reads=[]
            for scale in [1,2]:
                sample=crop if scale==1 else cv2.resize(crop,None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC)
                out=next(iter(model.predict(sample,batch_size=1,return_word_box=True)))
                text,alignment=out['rec_text'];reads.append((text,float(out['rec_score']),alignment))
            first,second=reads;inner=first[0].strip('“” ').strip()
            accepted=first[0]==second[0] and min(first[1],second[1])>=.7 and 0<len(inner)<=4 and first[0].startswith('“') and first[0].endswith('”')
            evidence.append({'box':box,'reads':[{'text':t,'confidence':s} for t,s,_ in reads],'accepted':accepted})
            if accepted:
                r['lines']=[t for t in r['lines'] if t is not left and t is not right]
                for text,(bx,by,ex,ey) in helpers['aligned_tokens'](first[0],first[2],box):
                    r['lines'].append({'text':text,'segment':left.get('segment'),'sourceRegion':left.get('sourceRegion'),'confidence':min(first[1],second[1]),'reviewRequired':True,'recognizer':'quoted-fragment-two-scales','position':{'x':bx/w,'y':by/h,'width':(ex-bx)/w,'height':(ey-by)/h}})
                r['quality']['issues'].append({'kind':'recovered-quoted-text','text':first[0],'box':box,'note':'Agreement of two scales is not independent verification.'})
            else:r['quality']['issues'].append({'kind':'unresolved-empty-quotes','box':box})
    r['quoteRecovery']=evidence;r['lines'].sort(key=lambda t:(t['position']['y'],t['position']['x']))
    for i,t in enumerate(r['lines']):t['id']=i
    r['quality']['tokens']=len(r['lines'])
    Path(a.result).write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
