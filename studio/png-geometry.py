"""Extract editable vector artwork and image bounds from a textbook PNG.
No page raster is included in the generated vectors; text remains HTML.
"""
import base64, json, sys
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import re


def extract(payload):
    data=base64.b64decode(payload['image'].split(',')[-1])
    image=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR)
    if image is None: raise ValueError('Invalid PNG')
    h,w=image.shape[:2]
    lines=payload.get('lines',[])
    textmask=np.zeros((h,w),np.uint8)
    boxes=[]
    for line in lines:
        p=line.get('position',{})
        x,y,bw,bh=[float(p.get(k,0)) for k in ('x','y','width','height')]
        x0,y0=max(0,int(x*w)-1),max(0,int(y*h)-1)
        x1,y1=min(w,int((x+bw)*w)+2),min(h,int((y+bh)*h)+2)
        if x1<=x0 or y1<=y0:continue
        boxes.append((x0,y0,x1,y1,line))
        textmask[y0:y1,x0:x1]=255
    b,g,r=[image[:,:,n].astype(np.int16) for n in range(3)]
    red=(r-g>22)&(r-b>15)&(r>125)
    # Images are recovered locally within the model's approximate proposals.
    texture=((np.max(image,axis=2).astype(int)-np.min(image,axis=2)>12)|(np.mean(image,axis=2)<170))&~red&(textmask==0)
    proposals=[x for x in payload.get('regions',[]) if x.get('kind')=='illustration']
    assets=[]
    for proposal in proposals:
        p=proposal['position'];x0=max(0,int(p['x']*w));y0=max(0,int(p['y']*h));x1=min(w,int((p['x']+p['width'])*w));y1=min(h,int((p['y']+p['height'])*h))
        crop=(texture[y0:y1,x0:x1]*255).astype(np.uint8)
        if not crop.size:continue
        crop=cv2.morphologyEx(crop,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
        contours,_=cv2.findContours(crop,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        if not contours:continue
        contour=max(contours,key=cv2.contourArea);x,y,cw,ch=cv2.boundingRect(contour)
        if cw*ch<w*h*.001:continue
        rect=(max(0,x0+x-2),max(0,y0+y-2),min(w,x0+x+cw+2),min(h,y0+y+ch+2))
        if any(abs(rect[0]-a[0])+abs(rect[1]-a[1])+abs(rect[2]-a[2])+abs(rect[3]-a[3])<20 for a in assets):continue
        assets.append(rect)
    # Restore flat fills behind OCR glyphs before tracing contours.
    masks=[((red)&(g<175)).astype(np.uint8)*255,((r-g>20)&(r-b>20)&(g>=160)).astype(np.uint8)*255]
    paths=[]
    for mask in masks:
        for x0,y0,x1,y1,line in boxes:
            outer=mask[max(0,y0-3):min(h,y1+3),max(0,x0-3):min(w,x1+3)].copy()
            border=np.concatenate([outer[0],outer[-1],outer[:,0],outer[:,-1]])
            inside=np.mean(mask[y0:y1,x0:x1]>0)
            mask[y0:y1,x0:x1]=255 if np.mean(border>0)>.55 or (inside>.4 and np.mean(border>0)>.18) else 0
        for x0,y0,x1,y1 in assets:mask[y0:y1,x0:x1]=0
        mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((2,2),np.uint8))
        contours,hierarchy=cv2.findContours(mask,cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:continue
        for idx,contour in enumerate(contours):
            if hierarchy[0][idx][3]>=0 or cv2.contourArea(contour)<3:continue
            parts=[];indices=[idx];child=hierarchy[0][idx][2]
            while child>=0:indices.append(child);child=hierarchy[0][child][0]
            for ci in indices:
                poly=cv2.approxPolyDP(contours[ci],.55,True).reshape(-1,2)
                if len(poly)<3:continue
                parts.append('M'+' L'.join(f'{x},{y}' for x,y in poly)+' Z')
            pixels=np.zeros((h,w),np.uint8);cv2.drawContours(pixels,contours,idx,255,-1)
            selected=image[(pixels>0)&(mask>0)]
            if not len(selected):continue
            fill=np.median(selected,axis=0).astype(int)
            paths.append({'d':' '.join(parts),'fill':'#%02x%02x%02x'%(fill[2],fill[1],fill[0])})
    regions=[{'kind':'illustration','position':{'x':x0/w,'y':y0/h,'width':(x1-x0)/w,'height':(y1-y0)/h}} for x0,y0,x1,y1 in assets]
    typography=[]
    candidates=[('STKAITI.TTF','STKaiti',False),('simsun.ttc','SimSun',False),('msyh.ttc','Microsoft YaHei',False),('msyhbd.ttc','Microsoft YaHei',True),('times.ttf','Times New Roman',False),('timesbd.ttf','Times New Roman',True),('timesi.ttf','Times New Roman',False),('arial.ttf','Arial',False),('arialbd.ttf','Arial',True)]
    fonts=[(ImageFont.truetype(str(Path('C:/Windows/Fonts')/f),64),name,bold,f) for f,name,bold in candidates if (Path('C:/Windows/Fonts')/f).exists()]
    for x0,y0,x1,y1,line in boxes:
        text=str(line.get('text',line.get('original',''))).strip()
        if not text:continue
        roi=image[y0:y1,x0:x1];gray=cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY)
        median=np.median(roi.reshape(-1,3),axis=0)
        white_on_red=median[2]>median[1]+25 and median[1]<180 and np.mean(gray>220)>.08
        # Foreground glyphs may be black, red or white on a red header.
        if white_on_red:target=(gray>210).astype(np.uint8)*255
        elif np.min(gray)<100:target=(gray<min(145,float(np.percentile(gray,20))+35)).astype(np.uint8)*255
        else:target=((roi[:,:,2].astype(int)-roi[:,:,1].astype(int)>35)&(gray<210)).astype(np.uint8)*255
        points=cv2.findNonZero(target)
        if points is None:continue
        tx,ty,tw,th=cv2.boundingRect(points)
        target=target[ty:ty+th,tx:tx+tw]
        if th<3 or tw<3:continue
        targetNorm=cv2.resize(target,(max(12,min(500,tw)),40)).astype(np.float32)/255
        best=None
        for font,name,bold,filename in fonts:
            if re.search('[\u3400-\u9fff]',text) and name in ('Times New Roman','Arial'):continue
            box=font.getbbox(text);fw,fh=box[2]-box[0],box[3]-box[1]
            if fw<1 or fh<1:continue
            rendered=Image.new('L',(fw+2,fh+2));ImageDraw.Draw(rendered).text((-box[0],-box[1]),text,font=font,fill=255)
            template=cv2.resize(np.array(rendered)[:fh,:fw],(targetNorm.shape[1],40)).astype(np.float32)/255
            score=float(np.mean(np.abs(cv2.GaussianBlur(template,(3,3),.8)-cv2.GaussianBlur(targetNorm,(3,3),.8))))
            if best is None or score<best[0]:best=(score,name,bold,filename,64*th/fh,tw/(fw*th/fh))
        if best:
            selected=roi[target[:roi.shape[0],:roi.shape[1]]>0] if target.shape==roi.shape[:2] else roi[gray<150]
            c=np.median(selected,axis=0).astype(int) if len(selected) else np.array([35,35,35])
            if white_on_red:c=np.array([255,255,255])
            typography.append({'id':line['id'],'fontName':best[1],'bold':best[2],'italic':best[3]=='timesi.ttf','fontSizePt':round(best[4],3),'fontSizeScale':1,'widthScale':round(max(.7,min(1.4,best[5])),4),'color':'#%02x%02x%02x'%(c[2],c[1],c[0])})
    return {'version':3,'width':w,'height':h,'paths':paths,'regions':regions,'typography':typography,'source':'PNG color contours, OCR text excluded'}


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(extract(json.load(sys.stdin)),ensure_ascii=False))
