"""Recover isolated tone marks only when printed shape agrees with nearby pinyin."""
import re
import unicodedata
import cv2
import numpy as np

MARKS={1:'ˉ',2:'ˊ',3:'ˇ',4:'ˋ'}
COMBINING={'\u0304':1,'\u0301':2,'\u030c':3,'\u0300':4}

def tone_of(text):
    tones={COMBINING[c] for c in unicodedata.normalize('NFD',text) if c in COMBINING}
    return next(iter(tones)) if len(tones)==1 else None

def shape_tone(mask):
    ys,xs=np.where(mask)
    if len(xs)<6:return None
    w=xs.max()-xs.min()+1;h=ys.max()-ys.min()+1
    if w>=3*h:return 1
    left=ys[xs<=np.quantile(xs,.3)];right=ys[xs>=np.quantile(xs,.7)]
    middle=ys[(xs>=np.quantile(xs,.4))&(xs<=np.quantile(xs,.6))]
    if len(middle) and np.mean(middle)>max(np.mean(left),np.mean(right))+1.2:return 3
    slope=np.polyfit(xs,ys,1)[0]
    return 2 if slope<-.25 else 4 if slope>.25 else None

def enrich(image, raw, result):
    h,w=image.shape[:2];ocr=raw['overall_ocr_res']
    regions=[{'text':t,'box':b,'index':i} for i,(t,b) in enumerate(zip(ocr['rec_texts'],ocr['rec_boxes']))]
    chinese=lambda s:bool(re.fullmatch(r'[\u3400-\u9fff]+',s))
    tables=[b['block_bbox'] for b in raw.get('parsing_res_list',[]) if b.get('block_label')=='table']
    recovered=[]
    for table in tables:
        tx,ty,tx1,ty1=table
        contained=[r for r in regions if tx<=sum(r['box'][::2])/2<=tx1 and ty<=sum(r['box'][1::2])/2<=ty1]
        initials=next((r for r in contained if r['text'].strip().casefold()=='initials'),None)
        finals=next((r for r in contained if r['text'].strip().casefold()=='finals'),None)
        if initials and finals:
            boundary=(sum(initials['box'][::2])+sum(finals['box'][::2]))/4
            for token in result['lines']:
                p=token['position'];px=(p['x']+p['width']/2)*w;py=(p['y']+p['height']/2)*h
                if tx<px<tx1 and max(initials['box'][3],finals['box'][3])<py<ty1:
                    replacement='l' if token['text']=='|' and px<boundary else 'o' if token['text']=='O' and px>boundary else None
                    if replacement:
                        token['originalText']=token['text'];token['text']=replacement;token['reviewRequired']=True
                        token['normalization']='phonetics-column-context'
                        result['quality']['issues'].append({'kind':'phonetic-context-normalization','sourceText':token['originalText'],'text':replacement,'position':p})
        header=next((r for r in contained if r['text'].strip().casefold()=='tones'),None)
        syllable=next((r for r in contained if r['text'].strip().casefold()=='syllables'),None)
        example=next((r for r in contained if r['text'].strip().casefold()=='example characters'),None)
        if not header or not syllable:continue
        sx,sy,sx1,sy1=syllable['box'];cx=(sx+sx1)/2
        rows=[r for r in contained if r['box'][1]>sy1 and r['box'][0]<=cx<=r['box'][2] and tone_of(r['text'])]
        hx,hy,hx1,hy1=header['box'];y0=int(hy1+3);x0=int(hx)
        mask=(cv2.cvtColor(image[y0:int(ty1),x0:int(hx1)],cv2.COLOR_BGR2GRAY)<130).astype(np.uint8)
        count,labels,stats,_=cv2.connectedComponentsWithStats(mask,8)
        for label in range(1,count):
            bx,by,bw,bh,area=map(int,stats[label])
            if not(6<=area<=1000 and 4<=bw<=70 and 2<=bh<=60) or not rows:continue
            center=y0+by+bh/2
            row=min(rows,key=lambda r:abs(center-(r['box'][1]+r['box'][3])/2))
            if abs(center-(row['box'][1]+row['box'][3])/2)>max(60,row['box'][3]-row['box'][1]):continue
            predicted=shape_tone(labels[by:by+bh,bx:bx+bw]==label)
            if predicted!=tone_of(row['text']):continue
            box=[x0+bx,y0+by,x0+bx+bw,y0+by+bh]
            recovered.append({'text':MARKS[predicted],'tone':predicted,'pinyin':row['text'],'box':box,'method':'printed-tone-shape-and-adjacent-pinyin-agree'})
            result['lines'].append({'text':MARKS[predicted],'reviewRequired':False,'source':'tone-shape-and-pinyin','tone':predicted,'pinyin':row['text'],'position':{'x':box[0]/w,'y':box[1]/h,'width':bw/w,'height':bh/h}})
        if example:
            ex=(example['box'][0]+example['box'][2])/2
            examples=[r for r in contained if r['box'][1]>example['box'][3] and chinese(r['text']) and r['box'][0]<=ex<=r['box'][2]]
            for row in rows:
                if not examples:continue
                target=min(examples,key=lambda r:abs(sum(r['box'][1::2])-sum(row['box'][1::2])))
                if abs(sum(target['box'][1::2])-sum(row['box'][1::2]))>120:continue
                for token in result['lines']:
                    if token.get('sourceRegion')==row['index'] or (token.get('pinyin')==row['text'] and abs(token['position']['y']*h-row['box'][1])<100):
                        token['speechText']=target['text'];token['speechSource']='adjacent-printed-example'
    # Standalone picture captions: pair pinyin with the Chinese label directly below.
    caption_regions=[{'text':e['text'],'box':e['box']} for e in result['evidence']]
    segments={e['segment']:e for e in result['evidence']}
    for token in result['lines']:
        if token.get('speechText') or not tone_of(token['text']) or token.get('sourceRegion') is None:continue
        region=segments.get(token.get('segment'),regions[token['sourceRegion']])
        if region['text'].strip()!=token['text'].strip():continue
        x,y,x1,y1=region['box'];cx=(x+x1)/2
        candidates=[r for r in caption_regions if chinese(r['text']) and r['box'][0]<=cx<=r['box'][2] and 0<r['box'][1]-y<h*.035]
        if candidates:
            target=min(candidates,key=lambda r:r['box'][1]);token['speechText']=target['text'];token['speechSource']='adjacent-printed-caption'
    result['quality']['recoveredToneMarks']=recovered
    result['lines'].sort(key=lambda t:(t['position']['y'],t['position']['x']))
    for i,token in enumerate(result['lines']):token['id']=i
    result['quality']['tokens']=len(result['lines'])
