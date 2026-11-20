import pikepdf, sys, json
from pikepdf import Operator as Op
H=841.8898
# variable text rects (top-left coords, pt) per page index
VAR_TEXT={
 0:[(165,90,465,202),(8,88,160,312),(70,368,345,389),(20,390,218,814),(226,390,439,695),(285,710,441,808),(474,462,572,500),(456,631,572,676)],
 1:[(16,8,572,108),(90,60,492,83),(290,133,535,147),(352,110,545,342),(40,554,201,816),(219,385,384,799),(394,385,556,799)],
 2:[(119,39,521,79),(78,148,490,211),(33,181,63,202),(27,225,200,638),(212,225,385,650),(397,225,570,500),(419,519,536,598),(216,752,391,768),(114,768,399,813),(438,708,546,772)],
 3:[(50,177,126,791),(189,77,519,88),(196,99,565,249),(205,322,535,435),(180,508,575,798)],
 4:[(367,113,543,178)],
}
# vector paths to drop: (page, rect top-left coords) - path bbox must lie inside
DROP_PATHS={0:[(10,258,160,292)], 3:[(178,316,572,440)]}
def inside(pt,r):
    x,y=pt; y=H-y
    return r[0]<=x<=r[2] and r[1]<=y<=r[3]
def mul(a,b):
    return [a[0]*b[0]+a[1]*b[2], a[0]*b[1]+a[1]*b[3], a[2]*b[0]+a[3]*b[2], a[2]*b[1]+a[3]*b[3], a[4]*b[0]+a[5]*b[2]+b[4], a[4]*b[1]+a[5]*b[3]+b[5]]
def ap(m,x,y): return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])
PATHOPS={'m','l','c','v','y','re','h'}
PAINT={'f','f*','F','S','s','B','B*','b','b*','n'}
def filt(ops, rects, prects, recolor):
    out=[]; ctm=[1,0,0,1,0,0]; st=[]; tm=[1,0,0,1,0,0]; tlm=[1,0,0,1,0,0]; TL=0
    path=[]; pathpts=[]
    removed=0; tr=0; bt_start=None; kept=0; dropped=0; killpaint=False
    for operands,op in ops:
        o=str(op)
        if killpaint:
            if o in ('sh','Do','INLINE IMAGE'): removed+=1; continue
            if o in ('Q','BT'): killpaint=False
        if o=='Tr': tr=int(operands[0])
        if o=='BT': bt_start=len(out); kept=0; dropped=0
        if o=='ET' and tr==7 and dropped and not kept:
            del out[bt_start:]; killpaint=True; removed+=1; continue
        if o=='q': st.append((ctm[:],tr))
        elif o=='Q':
            if st: ctm,tr=st.pop()
        elif o=='cm': ctm=mul([float(v) for v in operands],ctm)
        elif o=='BT': tm=[1,0,0,1,0,0]; tlm=tm[:]
        elif o=='Tm': tm=[float(v) for v in operands]; tlm=tm[:]
        elif o in('Td','TD'):
            tx,ty=float(operands[0]),float(operands[1]); tlm=mul([1,0,0,1,tx,ty],tlm); tm=tlm[:]
            if o=='TD': TL=-ty
        elif o=='TL': TL=float(operands[0])
        elif o=='T*': tlm=mul([1,0,0,1,0,-TL],tlm); tm=tlm[:]
        if o in ('Tj','TJ',"'",'"'):
            if o in ("'",'"'): tlm=mul([1,0,0,1,0,-TL],tlm); tm=tlm[:]
            pt=ap(mul(tm,ctm),0,0)
            if any(inside(pt,r) for r in rects):
                removed+=1; dropped+=1
                if o in ("'",'"'): out.append(([],Op('T*')))
                continue
        if o in ('Tj','TJ',"'",'"'): kept+=1
        if o in PATHOPS:
            path.append((operands,op))
            nums=[float(v) for v in operands]
            if o=='re':
                x,y,w,h=nums; pathpts+= [ap(ctm,x,y),ap(ctm,x+w,y+h)]
            else:
                pathpts+= [ap(ctm,nums[i],nums[i+1]) for i in range(0,len(nums)-1,2)]
            continue
        if o in PAINT and path:
            if prects and o!='n' and pathpts and any(all(inside(p,r) for p in pathpts) for r in prects):
                removed+=1
            else:
                out+=path; out.append((operands,op))
            path=[]; pathpts=[]; continue
        if path and o in ('W','W*'):
            path.append((operands,op)); continue
        if recolor and o in ('scn','sc') and len(operands)==3:
            v=tuple(round(float(x),4) for x in operands)
            for a,b in recolor:
                if v==a: operands=[pikepdf.objects.Decimal(str(round(c,4))) if False else c for c in b]
        out.append((operands,op))
    out+=path
    return out, removed
def hex2rgb(h): h=h.lstrip('#'); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))
def build(src,out,accent=None):
    pdf=pikepdf.open(src)
    for pn,page in enumerate(pdf.pages):
        rects=VAR_TEXT.get(pn,[]); prects=DROP_PATHS.get(pn,[])
        rec=[((1.0,0.7804,0.2588),hex2rgb(accent))] if (accent and pn==0) else None
        ops=pikepdf.parse_content_stream(page)
        new,n=filt(ops,rects,prects,rec)
        page.Contents=pdf.make_stream(pikepdf.unparse_content_stream(new))
        print('page',pn+1,'removed',n)
    pdf.save(out)
if __name__=='__main__': build(sys.argv[1],sys.argv[2],sys.argv[3] if len(sys.argv)>3 else None)
