"""Generic layout reconstruction. No page-specific text or coordinates."""
import argparse,json,html,unicodedata
from pathlib import Path
import cv2
import numpy as np

def vertical_rules(ink):
    foreground=ink>0
    body=foreground.mean(axis=1)<.25
    if body.sum()<len(body)*.3:return []
    columns=np.flatnonzero(foreground[body].mean(axis=0)>.75)
    runs=np.split(columns,np.where(np.diff(columns)>1)[0]+1)
    return [(int(run[0]),int(run[-1])+1) for run in runs if 1<len(run)<=25]

def framed_regions(image,box):
    x,y,x1,y1=map(int,box);crop=image[y:y1,x:x1]
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    ink=cv2.threshold(gray,245,255,cv2.THRESH_BINARY_INV)[1]
    ink=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(9,9)))
    contours,_=cv2.findContours(ink,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[]
    for contour in contours:
        a,b,c,d=cv2.boundingRect(contour)
        if d>crop.shape[0]*.15 and .1*crop.shape[1]<c<.8*crop.shape[1] and cv2.contourArea(contour)>.65*c*d:
            boxes.append([x+a,y+b,x+a+c,y+b+d])
    boxes.sort(key=lambda b:b[0])
    if len(boxes)<2 or sum((b[2]-b[0])*(b[3]-b[1]) for b in boxes)<crop.shape[0]*crop.shape[1]*.65:return [list(map(int,box))]
    return boxes

def build(scan, raw_path, result_path, destination, number):
    image=cv2.imread(str(scan));h,w=image.shape[:2]
    raw=json.loads(Path(raw_path).read_text(encoding='utf-8'));raw=raw.get('res',raw)
    result=json.loads(Path(result_path).read_text(encoding='utf-8'))
    out=Path(destination);assets=out/'assets';assets.mkdir(exist_ok=True)
    def rect(b):return f'left:{b[0]/w*100}%;top:{b[1]/h*100}%;width:{(b[2]-b[0])/w*100}%;height:{(b[3]-b[1])/h*100}%'
    def contains(b,p):return b[0]<=p[0]<=b[2] and b[1]<=p[1]<=b[3]
    blocks=raw.get('parsing_res_list',[]);elements=[];used=set();panels=[];media=[]
    # Recover broad printed red panels as CSS, excluding small text strokes.
    mask=cv2.inRange(image,(0,0,135),(175,180,255))
    # Keep colored print as a transparent decorative fragment. Text remains a
    # separate OCR-backed HTML layer, while the original ink texture and edges
    # are preserved. This is a small design asset, never a full-page scan.
    clean=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(7,7)))
    contours,hierarchy=cv2.findContours(clean,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
    decoration_index=0
    for idx,contour in enumerate(contours):
        if hierarchy[0][idx][3]!=-1:continue
        x,y,cw,ch=cv2.boundingRect(contour)
        large=cw>=w*.12 and ch>=h*.012
        density=(mask[y:y+ch,x:x+cw]>0).mean()
        badge=cw>=w*.015 and ch>=h*.008 and .65<cw/ch<1.5 and density>.6
        if not (large or badge):continue
        area=cv2.contourArea(contour)
        if area<cw*ch*.12:continue
        panel=[x,y,x+cw,y+ch];panels.append(panel)
        crop=image[y:y+ch,x:x+cw].copy();alpha=mask[y:y+ch,x:x+cw].copy()
        erase=np.zeros((ch,cw),np.uint8)
        for token in result['lines']:
            p=token['position'];tx=int(p['x']*w);ty=int(p['y']*h);tx1=int((p['x']+p['width'])*w);ty1=int((p['y']+p['height'])*h)
            if not contains(panel,((tx+tx1)/2,(ty+ty1)/2)):continue
            lx=max(x,tx);ly=max(y,ty);rx=min(x+cw,tx1);by=min(y+ch,ty1)
            if rx<=lx or by<=ly:continue
            patch=mask[max(0,ty):min(h,ty1),max(0,tx):min(w,tx1)]
            if patch.size==0 or (patch>0).mean()<.45:continue
            pad_x=max(3,int(w*.0008));pad_y=max(3,int(h*.0008))
            erase[max(0,ly-y-pad_y):min(ch,by-y+pad_y),max(0,lx-x-pad_x):min(cw,rx-x+pad_x)]=255
        if cv2.countNonZero(erase):
            crop=cv2.inpaint(crop,erase,12,cv2.INPAINT_TELEA)
            alpha[erase>0]=255
        rgba=cv2.cvtColor(crop,cv2.COLOR_BGR2BGRA)
        rgba[:,:,3]=alpha
        name=f'{number}-decoration-{decoration_index}.png';decoration_index+=1
        cv2.imwrite(str(assets/name),rgba,[cv2.IMWRITE_PNG_COMPRESSION,9])
        elements.append(f'<img aria-hidden="true" class="decoration" src="assets/{name}" alt="" style="{rect(panel)}">')
    for i,b in enumerate(blocks):
        box=b['block_bbox'];kind=b['block_label']
        if kind in ('image','chart'):
            for card_index,frame in enumerate(framed_regions(image,box) if kind=='image' else [list(map(int,box))]):
                x,y,x1,y1=frame;crop=image[y:y1,x:x1].copy();captions=[];texts=[]
                card_id=f'p{number}-image{i}-card{card_index+1}'
                for ti,token in enumerate(result['lines']):
                    p=token['position'];a=int(p['x']*w);c=int(p['y']*h);d=int((p['x']+p['width'])*w);e=int((p['y']+p['height'])*h)
                    if contains(frame,((a+d)/2,(c+e)/2)):
                        used.add(ti);texts.append(token['text'])
                        cv2.rectangle(crop,(max(0,a-x-2),max(0,c-y-2)),(min(x1-x,d-x+2),min(y1-y,e-y+2)),(255,255,255),-1)
                        text=html.escape(token['text'],quote=True)
                        captions.append(f'<span class="glyph" data-width="{(d-a)/w*100}" data-text="{text}" style="left:{(a-x)/(x1-x)*100}%;top:{(c-y)/(y1-y)*100}%;font-size:{(e-c)/w*82}cqw">{text}</span>')
                name=f'{card_id}.png';cv2.imwrite(str(assets/name),crop)
                label=html.escape(' '.join(texts) or 'Иллюстрация',quote=True)
                elements.append(f'<figure class="media-card" tabindex="0" data-media-id="{card_id}" aria-label="{label}" style="{rect(frame)}"><img src="assets/{name}" alt="{label}"><figcaption>{"".join(captions)}</figcaption></figure>')
                media.append({'id':card_id,'image':f'assets/{name}','box':frame,'text':texts,'audio':None,'video':None})
    # Find illustrations missed by layout OCR near decorative panels.
    residual=cv2.inRange(image,(0,0,0),(95,95,95))
    for token in result['lines']:
        q=token['position'];tx=int(q['x']*w);ty=int(q['y']*h);tw=int(q['width']*w);th=int(q['height']*h)
        cv2.rectangle(residual,(tx-6,ty-6),(tx+tw+6,ty+th+6),0,-1)
    for b in blocks:
        if b['block_label'] in ('image','chart'):
            x,y,x1,y1=map(int,b['block_bbox']);residual[y:y1,x:x1]=0
    residual=cv2.morphologyEx(residual,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(25,25)))
    count,labels,stats,centers=cv2.connectedComponentsWithStats(residual)
    for k,(x,y,cw,ch,area) in enumerate(stats[1:]):
        if not(w*.025<cw<w*.15 and h*.018<ch<h*.15 and area>cw*ch*.07):continue
        if not any(px-cw<x<px1 and py-ch<y<py1 for px,py,px1,py1 in panels):continue
        box=[max(0,x-8),max(0,y-8),min(w,x+cw+8),min(h,y+ch+8)]
        name=f'{number}-detail-{k}.png';cv2.imwrite(str(assets/name),image[box[1]:box[3],box[0]:box[2]])
        elements.append(f'<img class="illustration" src="assets/{name}" alt="Деталь иллюстрации" style="{rect(box)}">')
    for block in blocks:
        if block['block_label']!='table':continue
        x,y,x1,y1=map(int,block['block_bbox']);x=max(0,x-12);y=max(0,y-12);x1=min(w,x1+12);y1=min(h,y1+12);crop=image[y:y1,x:x1]
        # Printed rules are pale coloured lines; grayscale threshold loses them.
        hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
        channels=crop.astype('int16')
        ink=(((channels[:,:,2]-channels[:,:,0])>3)&((channels[:,:,2]-channels[:,:,1])>1)).astype('uint8')*255
        for horizontal in (True,False):
            if not horizontal:
                for start,end in vertical_rules(ink):
                    box=[x+start,y,x+end,y1]
                    elements.append(f'<div aria-hidden="true" class="cell" style="{rect(box)};border:0;background:#d5c9c6"></div>')
                continue
            length=max(40,int((x1-x)*.7 if horizontal else (y1-y)*.65))
            kernel=cv2.getStructuringElement(cv2.MORPH_RECT,(length,1) if horizontal else (1,length))
            closed=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,cv2.getStructuringElement(cv2.MORPH_RECT,(31,1) if horizontal else (1,31)))
            strokes=cv2.morphologyEx(closed,cv2.MORPH_OPEN,kernel,borderType=cv2.BORDER_CONSTANT,borderValue=0)
            count,labels,stats,centers=cv2.connectedComponentsWithStats(strokes)
            for sx,sy,sw,sh,area in stats[1:]:
                if (horizontal and (sh>20 or sw<length)) or (not horizontal and (sw>20 or sh<length)):continue
                box=[x+sx,y+sy,x+sx+sw,y+sy+sh]
                elements.append(f'<div aria-hidden="true" class="cell" style="{rect(box)};border:0;background:#d5c9c6"></div>')
    # Group by detected paragraphs/headings; remaining tokens form individual elements.
    groups=[]
    for b in blocks:
        if b['block_label'] not in ('text','paragraph_title','header','footer','number'):continue
        box=b['block_bbox'];tokens=[]
        for i,t in enumerate(result['lines']):
            p=t['position'];center=((p['x']+p['width']/2)*w,(p['y']+p['height']/2)*h)
            if i not in used and contains(box,center):tokens.append(t);used.add(i)
        if tokens:groups.append((box,tokens,b['block_label']))
    for i,t in enumerate(result['lines']):
        if i not in used:
            p=t['position'];groups.append(([p['x']*w,p['y']*h,(p['x']+p['width'])*w,(p['y']+p['height'])*h],[t],'text'))
    groups.sort(key=lambda g:(g[0][1],g[0][0]))
    for gid,(box,tokens,kind) in enumerate(groups):
        bw=box[2]-box[0];bh=box[3]-box[1];spans=[]
        tokens.sort(key=lambda t:(t.get("sourceRegion",100000),t["position"]["x"]))
        for t in tokens:
            p=t['position'];x=p['x']*w;y=p['y']*h;tw=p['width']*w;th=p['height']*h;text=html.escape(t['text'],quote=True)
            patch=mask[max(0,int(y)):min(h,int(y+th)),max(0,int(x)):min(w,int(x+tw))]
            red=patch.size>0 and (patch>0).mean()>.5 and any(contains(panel,(x+tw/2,y+th/2)) for panel in panels)
            color='#fff' if red else '#222'
            font='Arial,sans-serif' if any(unicodedata.combining(c) for c in unicodedata.normalize('NFD',t['text'])) else 'Georgia,KaiTi,SimSun,serif'
            spans.append(f'<span class="glyph" data-width="{tw/w*100}" data-text="{text}" style="color:{color};left:{(x-box[0])/bw*100}%;top:{(y-box[1])/bh*100}%;font-family:{font};font-size:{th/w*82}cqw">{text}</span>')
        elements.append(f'<section class="text-block {kind}" data-block="{gid}" data-font="{max(t["position"]["height"] for t in tokens)*h/w*82}" style="{rect(box)}">'+''.join(spans)+'</section>')
    page='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HTML/CSS — страница NUMBER</title><link rel="stylesheet" href="rebuild.css"><script type="module" src="rebuild.js"></script><header><a href="index.html">Страницы</a><select id="language"><option value="ru">Русский</option><option value="en">English</option><option value="kk">Қазақша</option><option value="de">Deutsch</option><option value="fr">Français</option><option value="es">Español</option></select><button id="translatePage">Перевести страницу</button><button id="restore">Исходный текст</button><a href="NUMBER.png" target="_blank">Скан для сравнения</a><output id="status">HTML/CSS. Экспериментальная реконструкция; возможны отличия и ошибки OCR.</output></header><main data-media-manifest="NUMBER.media.json" class="page" style="aspect-ratio:WIDTH/HEIGHT">CONTENT</main></html>'''
    page=page.replace('NUMBER',str(number)).replace('WIDTH',str(w)).replace('HEIGHT',str(h)).replace('CONTENT',''.join(elements))
    (out/f'{number}.html').write_text(page,encoding='utf-8')
    (out/f'{number}.media.json').write_text(json.dumps({'version':1,'cards':media},ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    p=argparse.ArgumentParser()
    for key in ['scan','raw','result','destination','number']:p.add_argument('--'+key,required=True)
    a=p.parse_args();build(a.scan,a.raw,a.result,a.destination,a.number)
