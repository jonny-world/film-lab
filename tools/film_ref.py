"""Python reference of the film-lab shader pipeline (mirrors app shaders)."""
import numpy as np, cv2, sys
sys.path.insert(0,'/home/claude/scripts'); import lutlib as L
G=2.4
dec=lambda v: np.clip(v,0,1)**G; enc=lambda v: np.clip(v,0,1)**(1/G)
W709=np.array([.2126,.7152,.0722],np.float32)
DEF=dict(strength=1.0,ev=0.0,soft=1.2,hal=0.16,bloom=0.0,vig=0.164,grain=None,gsize=1.0,border=True)
HAL_T=0.2; HAL_SIG=10.0; HAL_TINT=np.array([1.0,0.06,-0.47],np.float32)
BLOOM_T=0.55; BLOOM_SIG=54.0
VIG_P=1.87
GRAIN_MIX=(0.83,0.55); GRAIN_CH=np.array([1.0,0.92,1.08],np.float32)
def make_noise(n=1024,beta=0.5,seed=1):
    rng=np.random.default_rng(seed)
    def circ_blur(x,s):
        f=np.fft.fftfreq(n); k=np.exp(-2*np.pi**2*s*s*(f[:,None]**2+f[None,:]**2))
        return np.fft.ifft2(np.fft.fft2(x)*k).real
    out=np.zeros((n,n,4),np.float32)
    for c in range(4):
        a=circ_blur(rng.standard_normal((n,n)),1.0); b=circ_blur(rng.standard_normal((n,n)),2.2)
        a/=a.std(); b/=b.std(); v=a+beta*b; out[...,c]=v/v.std()
    return out
def sample_wrap_bilinear(tex,u,v):
    n=tex.shape[0]; x=u-0.5; y=v-0.5; x0=np.floor(x).astype(np.int64); y0=np.floor(y).astype(np.int64); fx=(x-x0)[...,None]; fy=(y-y0)[...,None]
    x0%=n; y0%=n; x1=(x0+1)%n; y1=(y0+1)%n
    return (tex[y0,x0]*(1-fx)*(1-fy)+tex[y0,x1]*fx*(1-fy)+tex[y1,x0]*(1-fx)*fy+tex[y1,x1]*fx*fy)
def render(src,lut,border_rgba=None,noise=None,frame=0,**kw):
    p=dict(DEF); p.update(kw); H,W,_=src.shape; k=min(H,W)/2160.0
    c=src.astype(np.float32)
    if p['soft']*k>0.05: c=cv2.GaussianBlur(c,(0,0),p['soft']*k)
    if p['ev']!=0: c=enc(dec(c)*2**p['ev'])
    c=c+(L.apply(lut,c)-c)*p['strength']
    lin=dec(c); Y=lin@W709
    small=cv2.resize(lin,(W//4,H//4),interpolation=cv2.INTER_AREA); Ys=small@W709
    hh=cv2.resize(cv2.GaussianBlur(np.maximum(Ys-HAL_T,0),(0,0),HAL_SIG*k/4),(W,H),interpolation=cv2.INTER_LINEAR)
    hb=cv2.resize(cv2.GaussianBlur(np.maximum(Ys-BLOOM_T,0),(0,0),BLOOM_SIG*k/4),(W,H),interpolation=cv2.INTER_LINEAR)
    yy,xx=np.mgrid[0:H,0:W].astype(np.float32)+0.5
    r=np.hypot(xx-W/2,yy-H/2)/np.hypot(W/2,H/2)
    out=lin*np.maximum(1-p['vig']*r**VIG_P,0)[...,None]
    out=out+p['hal']*np.maximum(hh-np.maximum(Y-HAL_T,0),0)[...,None]*HAL_TINT
    out=out+p['bloom']*hb[...,None]
    c=enc(np.maximum(out,0))
    if p['grain'] and p['grain']>0:
        Lm=np.clip(c@W709,0,1); amp=p['grain']*2*np.sqrt(np.clip(Lm*(1-Lm),0,0.25))
        rng=np.random.default_rng(frame); off=rng.random(2)*noise.shape[0]
        s=p['gsize']*k; n=sample_wrap_bilinear(noise,xx/s+off[0],yy/s+off[1])
        g=GRAIN_MIX[0]*n[...,3:4]+GRAIN_MIX[1]*n[...,:3]
        c=c+amp[...,None]*g*GRAIN_CH
    if p['border'] and border_rgba is not None:
        a=border_rgba[...,3:4]; c=c*(1-a)+border_rgba[...,:3]*a
    return np.clip(c,0,1).astype(np.float32)
