import numpy as np, scipy.sparse as sp, scipy.sparse.linalg as spl, cv2
N=33
def idx(r,g,b): return (r*N+g)*N+b   # r slowest here; .cube writes r fastest - handled in writer
def trilinear_weights(x):
    """x: (n,3) in [0,1] -> rows/cols/weights for sparse A (n x N^3)"""
    p=np.clip(x,0,1)*(N-1); i0=np.minimum(np.floor(p).astype(np.int32),N-2); f=p-i0
    rows=[];cols=[];vals=[]
    n=len(x); ar=np.arange(n)
    for dr in (0,1):
        wr=f[:,0] if dr else 1-f[:,0]
        for dg in (0,1):
            wg=f[:,1] if dg else 1-f[:,1]
            for db in (0,1):
                wb=f[:,2] if db else 1-f[:,2]
                rows.append(ar); cols.append(idx(i0[:,0]+dr,i0[:,1]+dg,i0[:,2]+db)); vals.append(wr*wg*wb)
    return np.concatenate(rows),np.concatenate(cols),np.concatenate(vals)
def apply(lut,x):
    """lut: (N,N,N,3) indexed [r,g,b]; x (...,3)"""
    sh=x.shape; x=x.reshape(-1,3)
    p=np.clip(x,0,1)*(N-1); i0=np.minimum(np.floor(p).astype(np.int32),N-2); f=(p-i0).astype(np.float32)
    out=np.zeros_like(x,dtype=np.float32)
    for dr in (0,1):
        wr=f[:,0] if dr else 1-f[:,0]
        for dg in (0,1):
            wg=f[:,1] if dg else 1-f[:,1]
            for db in (0,1):
                wb=f[:,2] if db else 1-f[:,2]
                out+=(wr*wg*wb)[:,None]*lut[i0[:,0]+dr,i0[:,1]+dg,i0[:,2]+db]
    return out.reshape(sh)
def second_diff_ops():
    n=N**3; mats=[]
    ar=np.arange(N)
    for axis in range(3):
        rows=[];cols=[];vals=[];k=0
        for a in range(N):
            for b in range(N):
                for c in range(1,N-1):
                    ijk=[None,None,None]
                    others=[a,b]
                    for s,(o) in enumerate([-1,0,1]):
                        t=[a,b]; t.insert(axis,c+o)
                        rows.append(k); cols.append(idx(*t)); vals.append([1,-2,1][s])
                    k+=1
        mats.append(sp.csr_matrix((vals,(rows,cols)),shape=(k,n)))
    return sp.vstack(mats).tocsr()
def identity():
    g=np.linspace(0,1,N,dtype=np.float32)
    return np.stack(np.meshgrid(g,g,g,indexing='ij'),-1)
def aggregate(src,dst,bins=96):
    q=np.clip((src*bins).astype(np.int32),0,bins-1); key=(q[:,0]*bins+q[:,1])*bins+q[:,2]
    u,inv,cnt=np.unique(key,return_inverse=True,return_counts=True)
    S=np.zeros((len(u),3));Dd=np.zeros((len(u),3))
    for c in range(3):
        S[:,c]=np.bincount(inv,src[:,c],len(u))/cnt; Dd[:,c]=np.bincount(inv,dst[:,c],len(u))/cnt
    return S,Dd,cnt
def fit(src,dst,w,lam=1.0,mu=1e-4,base=None):
    n=N**3
    r,c,v=trilinear_weights(src)
    A=sp.csr_matrix((v,(r,c)),shape=(len(src),n))
    Wd=sp.diags(w)
    L=second_diff_ops()
    if base is None: base=identity().reshape(-1,3)
    else: base=base.reshape(-1,3)
    M=(A.T@Wd@A + lam*(L.T@L) + mu*sp.eye(n)).tocsc()
    solve=spl.factorized(M)
    out=np.zeros((n,3))
    for ch in range(3):
        rhs=A.T@(w*dst[:,ch]) + mu*base[:,ch]
        out[:,ch]=solve(rhs)
    return out.reshape(N,N,N,3).astype(np.float32)
def write_cube(lut,path,title='film-lab'):
    with open(path,'w') as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {N}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for b in range(N):
            for g in range(N):
                for r in range(N):
                    v=np.clip(lut[r,g,b],0,1); f.write(f'{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}\n')
