// Launch intro: proposal 1 "Timeline Assembly" (ported from brand/intro-proposals). Pure function of time.
(() => {
const SH=["M286.43 303.37L303.09 277.23L342.17 215.53L291.79 215.49L259.81 266.04L236.1 303.36L286.43 303.37Z","M432.36,232.63l-25.11,39.54-19.66,31.2h217.01s.75,0,.75,0c.09,0,.09-.2,0-.22l-.63-.09-2.84-.39-41.24-5.92-83.41-11.98-13.3-2.01,10.23-16.35,15.16-23.81,17.16-27.09h-124.68s-11.37,10.05-11.37,10.05l-35.06,31.23-19.18,30.35-10.43,16.23h46.84s10.9-9.49,10.9-9.49l20.42-18.27,18.6-16.44,29.85-26.55Z","M285.01 338.22L285.02 380.14L266.6 380.14L266.62 338.22L253.37 338.23L253.36 380.19L235 380.19L234.99 321.58L310.19 321.58L316.77 328.24L316.77 380.16L298.33 380.16L298.37 338.22L285.01 338.22Z","M468.97,363.36l.03,16.8h-63.88s-7.22-6.96-7.22-6.96l.06-44.85,6.76-6.77h51.85s6.72,6.77,6.72,6.77l-.03,29.43-5.49,5.53,11.2.05ZM416.31,338.19v25.17s28.77,0,28.77,0v-25.17s-28.77,0-28.77,0Z","M371.73,365.47h-28.65s0,14.7,0,14.7h-18.42s0-51.73,0-51.73l6.85-6.86h52.05s6.6,6.6,6.6,6.6l.02,51.97h-18.51s.05-14.68.05-14.68ZM343.08,338.19v10.93s28.67.01,28.67.01v-10.93s-28.67-.01-28.67-.01Z","M598.92,380.15h-51.27s-7.13-6.89-7.13-6.89c-.16-.55-.1-1.47.06-2.18v-42.95s6.58-6.56,6.58-6.56h52.08s6.68,6.69,6.68,6.69l-.07,44.95-6.93,6.93ZM587.45,338.2h-28.68s0,25.36,0,25.36h28.68s0-25.36,0-25.36Z","M511.21 380.18L492.84 380.17L492.77 372.7L492.75 338.22L470.25 338.22L470.28 321.57L533.7 321.58L533.73 338.22L511.19 338.23L511.21 380.18Z"];
const acc=a=>`rgba(92,211,198,${a})`,wh=a=>`rgba(255,255,255,${a})`;
const cl=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const seg=(t,a,b)=>cl((t-a)/(b-a));
const lerp=(a,b,k)=>a+(b-a)*k;
const eOut=k=>k>=1?1:(k<=0?0:1-Math.pow(2,-10*k));
const bOut=(k,c1=2.2)=>{k=cl(k);const c3=c1+1;return 1+c3*Math.pow(k-1,3)+c1*Math.pow(k-1,2)};
const cIO=k=>{k=cl(k);return k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2};
const eIn=k=>{k=cl(k);return k*k*k};
const inv=(f,y)=>{let lo=0,hi=1;for(let i=0;i<30;i++){const m=(lo+hi)/2;f(m)<y?lo=m:hi=m}return(lo+hi)/2};
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

const SYM=[new Path2D(SH[0]),new Path2D(SH[1])];
const SYMALL=new Path2D();SYMALL.addPath(SYM[0]);SYMALL.addPath(SYM[1]);
const SYMBB=[[236.1,215.5,342.2,303.4],[305.8,215.5,605.4,303.4]];
const LET=[2,4,3,6,5].map(i=>new Path2D(SH[i]));   // M A Q T O
const LCX=[275.9,357.45,433.45,502,573.15],LY=350.9;
const CX=420.5;
const SLOPE=0.6346;                                  // x shift per y unit of the logo slant
const l1=y=>342.17-SLOPE*(y-215.49),l2=y=>291.79-SLOPE*(y-215.49);

function clean(ctx){ctx.fillStyle=acc(1);SYM.forEach(p=>ctx.fill(p));LET.forEach(p=>ctx.fill(p))}
function rr(ctx,x,y,w,h,r){r=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
function poly(ctx,pts){ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]));ctx.closePath()}

const DUR=2.65,TX=2.4;
function stage(ctx,t,w,h,fn){
  ctx.clearRect(0,0,w,h);
  const e=seg(t,TX,DUR);if(e>=1)return;
  const s=w*0.45/377*(1+0.04*eOut(e));
  ctx.save();
  ctx.globalAlpha=1-cIO(e);
  ctx.translate(w/2,h/2);ctx.scale(s,s);ctx.translate(-CX,-298);
  fn(ctx,t);
  ctx.restore();
}

/* 1 Timeline Assembly */
const R1_LY=[233,259.5,286];
const R1_CL=[[0,236,64,-1,.9],[0,330,100,1,.55],[0,470,110,-1,.75],[1,262,100,1,.6],[1,390,96,-1,.85],[1,520,80,1,.5],[2,244,84,-1,.5],[2,356,110,1,.8],[2,500,90,-1,.65]];
const R1_PX=t=>lerp(228,640,cIO(seg(t,.62,1.55)));
(()=>{const cnt=[0,0],idx=[];R1_CL.forEach(c=>{const g=(c[1]+c[2]/2)<340?0:1;c.g=g;c.idx=cnt[g]++});R1_CL.forEach(c=>c.cnt=cnt[c.g])})();
const R1_TC=LCX.map(x=>.62+.93*inv(cIO,(x-228)/412));
function r1(ctx,t){
  const TD=2.05;if(t>=TD){clean(ctx);return}
  const lin=eOut(seg(t,0,.22)),lout=cIO(seg(t,1.8,TD)),hw=230*lin*(1-lout),flash=1-seg(t,0,.28);
  if(hw>.1)R1_LY.forEach(y=>{
    ctx.fillStyle=wh(.05);ctx.fillRect(CX-hw,y-10,hw*2,20);
    ctx.fillStyle=acc(.4*flash);ctx.fillRect(CX-hw,y-10,hw*2,20);
    ctx.strokeStyle=wh(.17);ctx.lineWidth=1;ctx.strokeRect(CX-hw,y-10,hw*2,20);
  });
  const px=R1_PX(t);
  R1_CL.forEach((c,i)=>{
    const t0=.08+i*.055,k=seg(t,t0,t0+.32);if(k<=0)return;
    const w=c[2],cx=c[1]+w/2,rx=c[1]+c[3]*340*(1-bOut(k,2)),ry=R1_LY[c[0]]-7;
    const m=cIO(seg(px,cx-40,cx+40));
    const bb=SYMBB[c.g],sw=(bb[2]-bb[0])/c.cnt;
    const x=lerp(rx,bb[0]+c.idx*sw,m),y=lerp(ry,bb[1],m),ww=lerp(w,sw*.9,m),hh=lerp(14,bb[3]-bb[1],m);
    const a=c[4]*(1-m*m)*Math.min(1,k*4);if(a<=.002)return;
    ctx.fillStyle=acc(a);rr(ctx,x,y,ww,hh,lerp(3,0,m));ctx.fill();
  });
  ctx.save();ctx.beginPath();ctx.rect(-2000,0,px+2000,1000);ctx.clip();
  ctx.fillStyle=acc(1);SYM.forEach(p=>ctx.fill(p));ctx.restore();
  LET.forEach((p,i)=>{
    const k=seg(t,R1_TC[i]-.06,R1_TC[i]+.2);if(k<=0)return;
    ctx.save();ctx.translate(0,-46*(1-bOut(k,2)));ctx.fillStyle=acc(Math.min(1,k*6));ctx.fill(p);ctx.restore();
  });
  const pa=seg(t,.5,.6)*(1-seg(t,1.5,1.62));
  if(pa>0){ctx.strokeStyle=wh(.9*pa);ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(px,203);ctx.lineTo(px,390);ctx.stroke();
    ctx.fillStyle=acc(pa);poly(ctx,[[px-6,203],[px+6,203],[px,214]]);ctx.fill()}
}


window.introTimeline = { DUR, render: (ctx, t, w, h) => stage(ctx, t, w, h, r1) };
})();
