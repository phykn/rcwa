#include "S4.h"
#include "S4_internal.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>
static void ok(int r,const char*n){if(r){fprintf(stderr,"%s: %d\n",n,r);exit(2);}}
static int mat(S4_Simulation*S,const char*name,double n,double k){double e[2]={n*n-k*k,2*n*k};int m=S4_Simulation_SetMaterial(S,-1,name,S4_MATERIAL_TYPE_SCALAR_COMPLEX,e);if(m<0) exit(2);return m;}
int main(){
 double px,py,wl,theta,phi,n0,ns,ks; int hx,hy,nl;
 if(scanf("%lf %lf %lf %lf %lf %d %d %lf %lf %lf %d",&px,&py,&wl,&theta,&phi,&hx,&hy,&n0,&ns,&ks,&nl)!=11)return 2;
 std::vector<double>L(8*nl);for(auto&v:L) if(scanf("%lf",&v)!=1)return 2;
 int N=(2*hx+1)*(2*hy+1);std::vector<int>G(2*N);int gi=1;
 for(int y=-hy;y<=hy;++y)for(int x=-hx;x<=hx;++x)if(x||y){G[2*gi]=x;G[2*gi+1]=y;++gi;}
 theta*=acos(-1)/180;phi*=acos(-1)/180;
 for(int pol=0;pol<2;++pol){
 double lattice[4]={px,0,0,py};auto S=S4_Simulation_New(lattice,N,G.data());
 double zero=0;int a=mat(S,"ambient",n0,0),b=mat(S,"substrate",ns,ks),top=S4_Simulation_SetLayer(S,-1,"top",&zero,-1,a);
 for(int i=0;i<nl;++i){double d=L[8*i],wx=L[8*i+1],wy=L[8*i+2];bool circle=L[8*i+7]==1;char name[40];snprintf(name,40,"m%d",i);int r=mat(S,name,L[8*i+3],L[8*i+4]);snprintf(name,40,"b%d",i);int bg=mat(S,name,L[8*i+5],L[8*i+6]);snprintf(name,40,"layer%d",i);
 int li=S4_Simulation_SetLayer(S,-1,name,&d,-1,(!circle&&wx==px&&wy==py)?r:bg);
 if(wx>0&&wy>0&&(circle||wx<px||wy<py)){double hw[2]={wx/2,wy/2},center[2]={px/2,py/2};ok(S4_Layer_SetRegionHalfwidths(S,li,r,circle?S4_REGION_TYPE_CIRCLE:S4_REGION_TYPE_RECTANGLE,hw,center,&zero),"region");}}
 int bot=S4_Simulation_SetLayer(S,-1,"bottom",&zero,-1,b);
 double freq[2]={1/wl,0},kdir[3]={sin(theta)*cos(phi),sin(theta)*sin(phi),cos(theta)},udir[3]={-sin(phi),cos(phi),0},u[2]={double(pol==0),0},v[2]={double(pol==1),0};
 ok(S4_Simulation_SetFrequency(S,freq),"frequency");ok(S4_Simulation_ExcitationPlanewave(S,kdir,udir,u,v),"excitation");
 double ft[4],fb[4];ok(S4_Simulation_GetPowerFlux(S,top,&zero,ft),"top flux");ok(S4_Simulation_GetPowerFlux(S,bot,&zero,fb),"bot flux");std::vector<double>pt(4*N),pb(4*N);
 ok(Simulation_GetPoyntingFluxByG(S,&S->layer[top],0,pt.data()),"top orders");ok(Simulation_GetPoyntingFluxByG(S,&S->layer[bot],0,pb.data()),"bot orders");
 printf("%c %.17g %.17g %.17g %d\n",pol?'p':'s',-ft[1]/ft[0],fb[0]/ft[0],ft[0],S->n_G);
 std::vector<double>at(4*N),bt(4*N),ab(4*N),bb(4*N);
 ok(Simulation_GetAmplitudes(S,&S->layer[top],0,at.data(),bt.data()),"top amplitudes");
 ok(Simulation_GetAmplitudes(S,&S->layer[bot],0,ab.data(),bb.data()),"bot amplitudes");
 for(int i=0;i<S->n_G;++i){
  double kx=n0*sin(theta)*cos(phi)+S->G[2*i]*wl/px,ky=n0*sin(theta)*sin(phi)+S->G[2*i+1]*wl/py;
  double alpha=(kx==0&&ky==0)?phi:atan2(ky,kx),c=cos(alpha),ss=sin(alpha);
  std::complex<double>rtx(bt[2*i],bt[2*i+1]),rty(bt[2*(i+N)],bt[2*(i+N)+1]);
  std::complex<double>ttx(ab[2*i],ab[2*i+1]),tty(ab[2*(i+N)],ab[2*(i+N)+1]);
  std::complex<double>eps(ns*ns-ks*ks,2*ns*ks),qt=sqrt(std::complex<double>(n0*n0-kx*kx-ky*ky,0)),qb=sqrt(eps-kx*kx-ky*ky);
  double Rs=norm((c*rtx+ss*rty)/qt)*qt.real()/ft[0],Rp=norm(-ss*rtx+c*rty)*(qt/(n0*n0)).real()/ft[0];
  double Ts=norm((c*ttx+ss*tty)/qb)*qb.real()/ft[0],Tp=norm(-ss*ttx+c*tty)*(qb/eps).real()/ft[0];
  printf("%d %d %.17g %.17g %.17g %.17g %.17g %.17g\n",S->G[2*i],S->G[2*i+1],-pt[4*i+1]/ft[0],pb[4*i]/ft[0],Rs,Rp,Ts,Tp);
 }S4_Simulation_Destroy(S);
 }
}
