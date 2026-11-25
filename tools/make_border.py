import numpy as np, cv2
from PIL import Image
W,H=3840,2160
L,R,T,B=44,40,40,40; RAD=110; FEATHER=3.0
rng=np.random.default_rng(7)
def smooth_noise(sig,amp):
    n=rng.standard_normal((H//4,W//4)).astype(np.float32)
    n=cv2.GaussianBlur(n,(0,0),sig/4,borderType=cv2.BORDER_REFLECT)
    n/=n.std()+1e-9; return cv2.resize(n,(W,H),interpolation=cv2.INTER_CUBIC)*amp
yy,xx=np.mgrid[0:H,0:W].astype(np.float32)+0.5
# rounded-rect SDF (positive inside image area)
cx0,cx1,cy0,cy1=L,W-R,T,H-B
hx=(cx1-cx0)/2; hy=(cy1-cy0)/2; mx=(cx0+cx1)/2; my=(cy0+cy1)/2
qx=np.abs(xx-mx)-(hx-RAD); qy=np.abs(yy-my)-(hy-RAD)
outside=np.hypot(np.maximum(qx,0),np.maximum(qy,0))+np.minimum(np.maximum(qx,qy),0)-RAD
d=-outside  # >0 inside picture
fine=rng.standard_normal((H,W)).astype(np.float32); fine=cv2.GaussianBlur(fine,(0,0),1.5); fine/=fine.std()
d=d+smooth_noise(40,1.4)+smooth_noise(10,0.6)+fine*0.35
alpha=1-np.clip(d/FEATHER+0.5,0,1)        # 1 = border
alpha=cv2.GaussianBlur(alpha,(0,0),0.8)
rgba=np.zeros((H,W,4),np.uint8); rgba[...,0]=13; rgba[...,1]=15; rgba[...,2]=19; rgba[...,3]=np.round(alpha*255).astype(np.uint8)
Image.fromarray(rgba,'RGBA').save('/home/claude/film-lab/assets/border.png',optimize=True)
print('saved', alpha.mean())
