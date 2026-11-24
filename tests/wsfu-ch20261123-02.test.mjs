// CH-20261123-02 회귀 시험 — 실행: node --test tests/wsfu-ch20261123-02.test.mjs
//   1-2 최대압 >= 550 · 2-1 소변기 세정밸브 접속 20A · 2-2 주방싱크 3 DFU · 2-3 FD(상시) 삭제·저장본 변환
//   2-4 건물 용도별 DFU (KDS 31 30 25:2026 표 4.1-2, 빈칸은 표 4.1-3)
//   U1 기구급수부하단위(매뉴얼 2022 표 9) → 동시사용 유량표(표 10) → 유속 2.5 / 급폐쇄 1.2 m/s · 허용마찰 (학회 2010 3.2)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const src=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(t=>t.includes('const FX_KEYS'));

function load(saved=null){
  const el=()=>({innerHTML:'',value:'',style:{},click(){},addEventListener(){},classList:{toggle(){},add(){},remove(){}},
    querySelectorAll:()=>[],appendChild(){},setAttribute(){}});
  const els={}, alerts=[];
  const ctx={console,Math,JSON,Date,setTimeout(){},clearTimeout(){},alert(m){alerts.push(m);},confirm:()=>true,
    URL:{createObjectURL(){return ''},revokeObjectURL(){}},Blob:function(){},
    localStorage:{getItem(){return saved},setItem(){},removeItem(){}},
    document:{getElementById:id=>els[id]||(els[id]=el()),querySelectorAll:()=>[],querySelector:()=>null,createElement:el,addEventListener(){},body:el()},
    navigator:{userAgent:''},location:{search:'',hash:''}};
  ctx.window=ctx; ctx.window.addEventListener=()=>{};
  vm.createContext(ctx);
  let initErr=null;
  try{ vm.runInContext(src,ctx); }catch(e){ initErr=e; }
  return {initErr,alerts,run:code=>{const v=vm.runInContext(`(()=>{${code}})()`,ctx);return v===undefined?undefined:JSON.parse(JSON.stringify(v));}};
}
// 화장실 하나: [[기구키, 개수, 연속사용 개수]...]
const ZONE=(name,floor,list,extra='')=>`{
  const z=newZone(${JSON.stringify(name)},${JSON.stringify(floor)}); let prev=z.pipe.rootId;
  for(const [k,q,c] of ${JSON.stringify(list)}){ const n=newPipeNode('fixture'); n.fxKey=k; n.qty=q; if(c){n.cont=true;n.contQty=c;}
    z.pipe.nodes[n.id]=n; z.pipe.nodes[prev].mainNext=n.id; prev=n.id; }
  ${extra}
  S.zones.push(z); }`;
const RESET=`S.zones=[]; S.cw={floors:[],risers:[],main:{riserIds:[],floorIds:[],zoneIds:[]}};
  S.dr={floors:[],risers:[],main:{riserIds:[],floorIds:[],zoneIds:[]}};
  S.supplyType='booster'; S.mainLocation='bottom'; S.cwSizeMode='wsfu'; S.bldgUse='general'; S.maxPressureKPa=0;
  S.pressure={supplyKPa:null,floorH:3,material:'stainless',mainLen:10,branchLen:8,zoneLen:3,minResidualKPa:55,fittingFactor:1.4,kPipe:3};`;

test('초기화가 오류 없이 끝나고 주요 화면이 그려진다', ()=>{
  const app=load();
  assert.equal(app.initErr,null);
  app.run(RESET+ZONE('1층 화장실','1층',[['wc_v',2],['ur_v',2],['bas_p',2],['sink',1]])+`
    for(const f of ['renderResult','renderMainPipeTab','renderPressureTab','exportCSV']) globalThis[f]();
    for(let i=0;i<8;i++) renderTab(i);`);
});

test('표 10 — 반올림(0.5 올림·0.4 버림)과 위로 근접, 세정탱크형·세정밸브형 열', ()=>{
  const app=load();
  const q=app.run(`return [wsfuFlow(9.4,false),wsfuFlow(9.5,false),wsfuFlow(2,false),wsfuFlow(0.3,false),
    wsfuFlow(21,true),wsfuFlow(5,true),wsfuFlow(1,true),wsfuFlow(130,false),wsfuFlow(3000,true),wsfuFlow(20000,false),wsfuFlow(0,true)]`);
  assert.deepEqual(q,[28,30,11,11,144,83,83,201,1649,2990,0]);
});

test('WSFU 값 — 매뉴얼 표 9, 대변기 6 L·소변기 3.8 L 행, 용도 열과 빈칸 처리', ()=>{
  const app=load();
  const g=app.run(RESET+`return FX_KEYS.map(k=>[k,wsfuOf(k)])`);
  assert.deepEqual(Object.fromEntries(g),{wc_v:5,wc_t:2.5,ur_v:4,ur_t:4,bas_p:1,bas_i:1,shw:2,bath:4,sink:1,cls:3,fd_e:0,wsh:4});
  const a=app.run(RESET+`S.bldgUse='assembly'; return [wsfuInfo('wc_v'),wsfuInfo('ur_v'),wsfuInfo('cls')]`);
  assert.deepEqual(a,[{v:8,fallback:false},{v:5,fallback:false},{v:3,fallback:true}]);
  const m=app.run(RESET+`S.bldgUse='multi'; return [wsfuOf('bas_p'),wsfuOf('wsh'),wsfuInfo('ur_v')]`);
  assert.deepEqual(m,[0.5,2.5,{v:4,fallback:true}]);
});

test('보완 ①② 기구 1개만 맡는 구간은 KDS 표 4.5-1 관경 그대로 — 대변기 세정밸브 1개 25A (STS·동관 모두)', ()=>{
  const app=load();
  for(const mat of ['stainless','copper','pvc']){
    const r=app.run(RESET+`S.pressure.material='${mat}';`+ZONE('A','1층',[['wc_v',1]])+`const r=calcZone(S.zones[0]); return {p:r.cwPipe,q:r.cwQ,w:r.cwPipeW,n:r.cwN}`);
    assert.equal(r.q,83); assert.equal(r.n,1); assert.equal(r.p,25,mat); assert.equal(r.w,25);
  }
  // 소변기 세정밸브 1개 20A, 세면기 1개 15A (급탕도 15A)
  const u=app.run(RESET+ZONE('A','1층',[['ur_v',1]])+`return calcZone(S.zones[0]).cwPipe`);
  const b=app.run(RESET+ZONE('A','1층',[['bas_p',1]])+`const r=calcZone(S.zones[0]); return [r.cwPipe,r.hwPipe]`);
  assert.equal(u,20); assert.deepEqual(b,[15,15]);
});

test('보완 ③④ 기구 2개 이상은 WSFU·유속 2.5 m/s — 대변기 세정밸브 2개 32A, 4+4+4 화장실 40A (급폐쇄 1.2 m/s 없음)', ()=>{
  const app=load();
  const r2=app.run(RESET+ZONE('A','1층',[['wc_v',2]])+`const r=calcZone(S.zones[0]); return {p:r.cwPipe,q:r.cwQ,v:velocityMat(r.cwQ,r.cwPipe,'stainless'),v25:velocityMat(r.cwQ,25,'stainless'),wha:r.wha}`);
  assert.equal(r2.q,102); assert.equal(r2.p,32); assert.ok(r2.v<=2.5&&r2.v>1.9&&r2.v25>2.5); assert.equal(r2.wha,true);
  const r4=app.run(RESET+ZONE('A','1층',[['wc_v',4],['ur_v',4],['bas_p',4]])+`const r=calcZone(S.zones[0]); return {p:r.cwPipe,q:r.cwQ,v:velocityMat(r.cwQ,r.cwPipe,'stainless'),v32:velocityMat(r.cwQ,32,'stainless')}`);
  assert.equal(r4.q,178); assert.equal(r4.p,40); assert.ok(r4.v<=2.5&&r4.v32>2.5);
  const src=app.run(`return [typeof WS_VMAX_QC, String(wsfuPipe).includes('1.2')]`);
  assert.deepEqual(src,['undefined',false]);
});

test('세정밸브가 없는 화장실 — 세정탱크 대변기 4·세면기 4 (중앙급탕)', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['wc_t',4],['bas_p',4]])+`const r=calcZone(S.zones[0]); return {ws:r.wsCw,q:r.cwQ,p:r.cwPipe,wha:r.wha,hws:r.wsHw,hq:r.hwQ,hp:r.hwPipe}`);
  // 급수 WSFU = 2.5×4 + 1×4×3/4 = 13 → 세정탱크형 38 L/min. 급탕 = 1×4×3/4 = 3 → 11 L/min
  assert.equal(r.ws,13); assert.equal(r.q,38); assert.equal(r.wha,false);
  assert.equal(r.hws,3); assert.equal(r.hq,11);
  assert.equal(r.p,20);   // 38 L/min: 15A(14.28) 3.95 m/s > 2.5 → 20A(20.22) 1.97 m/s (공급압 미입력 — 유속만)
  const v=app.run(`return [velocityMat(38,15,'stainless'),velocityMat(38,20,'stainless')]`);
  assert.ok(v[0]>2.5 && v[1]<=2.5);
});

test('보완 — 「고정 0.85(legacy)」 삭제: 옛 저장본은 계수표로 바꾸고 알린다', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['wc_v',2]])+`S.cwSimultMode='legacy'; normalizeState(); const w=LOAD_WARN.slice(); LOAD_WARN.length=0;
    S.cwSizeMode='equiv'; S.cw.main.zoneIds=[S.zones[0].id]; const m=calcMainType('cw');
    return {mode:S.cwSimultMode, w:w.some(x=>/0\.85/.test(x)), f:m.cwSimultF}`);
  assert.equal(r.mode,'curve'); assert.equal(r.w,true); assert.notEqual(r.f,0.85);
});

test('급탕 3/4 규칙 — 개별 온수기(local)면 급수관이 전량 WSFU 를 진다', ()=>{
  const app=load();
  const c=app.run(RESET+ZONE('A','1층',[['bas_p',4]])+`return calcZone(S.zones[0]).wsCw`);
  const l=app.run(RESET+ZONE('A','1층',[['bas_p',4]],`z.hwSource='local'; z.elecHW=true;`)+`return calcZone(S.zones[0]).wsCw`);
  assert.equal(c,3); assert.equal(l,4);
});

test('연속사용 기구 — WSFU 에서 빼고 KDS 유량을 더한다 (표 9 주 7)', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['wc_t',2,1]])+`const r=calcZone(S.zones[0]); return {ws:r.wsCw,q:r.cwQ}`);
  assert.equal(r.ws,2.5); assert.equal(r.q,11+11);   // 2.5 → 3 → 11 L/min + 연속 1대 11 L/min
});

test('이중 적용 없음 — 상위 단계는 WSFU 원시 합계로 표 10 을 다시 찾는다', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('1층','1층',[['wc_v',4]])+ZONE('2층','2층',[['wc_v',4]])+`
    S.cw.main.zoneIds=S.zones.map(z=>z.id); const z=calcZone(S.zones[0]), m=calcMainType('cw');
    return {zq:z.cwQ,mws:m.wsCw,mq:m.cwQ}`);
  assert.equal(r.zq,132);           // 20 WSFU 세정밸브형
  assert.equal(r.mws,40); assert.equal(r.mq,178);   // 40 WSFU → 178 (132×2 가 아님)
});

test('허용마찰 s = (H−P)/(K(L+l)) — 압력검토 입력과 연결, 선택 관경은 마찰·유속을 모두 만족', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('5층 화장실','5층',[['wc_v',4],['ur_v',4],['bas_p',4]])+`
    S.pressure.supplyKPa=250; const F={id:'F5',name:'5층',zoneIds:[S.zones[0].id]}; S.cw.floors.push(F);
    S.cw.risers.push({id:'R1',name:'R',floorIds:['F5'],zoneIds:[],hLen:20}); S.cw.main.riserIds.push('R1');
    const af=allowFriction(); const q=300, d=wsfuPipe(q,false), prev=PIPE_SIZES_ALL[PIPE_SIZES_ALL.indexOf(d)-1];
    return {af, d, f:frictionLossKPa(q,d,1,'stainless'), v:velocityMat(q,d,'stainless'),
      fp:frictionLossKPa(q,prev,1,'stainless'), vp:velocityMat(q,prev,'stainless')}`);
  // H = 250 − 4층×3 m×9.81 = 132.28, P = 100 (세정밸브), L = 10 + 12, l = 20 (입상관 hLen), K = 3
  const s=(250-12*9.81-100)/(3*(22+20));
  assert.ok(Math.abs(r.af.s-s)<1e-9, `s ${r.af.s} vs ${s}`);
  assert.ok(r.f<=r.af.s && r.v<=2.5);
  assert.ok(r.fp>r.af.s || r.vp>2.5);
});

test('공급압 부족(H ≤ P)이면 허용마찰을 버리고 유속만 — 이유를 돌려준다', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('10층','10층',[['wc_v',1]])+`S.pressure.supplyKPa=120; return allowFriction()`);
  assert.equal(r.s,null); assert.equal(r.reason,'short');
  const n=app.run(RESET+ZONE('1층','1층',[['wc_v',1]])+`return allowFriction()`);
  assert.equal(n.reason,'noSupply');
});

test('비교 열 — WSFU 방식에서도 관균등표 결과를 함께 낸다 (소변기 20A 반영)', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['wc_v',4],['ur_v',4],['bas_p',4]])+`const r=calcZone(S.zones[0]); return [r.cwPipeEq,r.cwPipeAlt,r.cwPipeW,r.cwPipe]`);
  // 관균등: 4×4.9×0.65 + (4×2.6 + 4×1.0)×0.70 = 12.74 + 10.08 = 22.82 → 50A
  assert.equal(r[0],50); assert.equal(r[1],50); assert.equal(r[2],r[3]);
  const e=app.run(RESET+`S.cwSizeMode='equiv';`+ZONE('A','1층',[['wc_v',4],['ur_v',4],['bas_p',4]])+`const r=calcZone(S.zones[0]); return [r.cwPipe,r.cwPipeAlt,r.cwPipeW]`);
  assert.equal(e[0],50); assert.equal(e[1],e[2]);
});

test('2-1 소변기 세정밸브 접속 20A — 소변기 1개 화장실도 20A 이상', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['ur_v',1]])+`return [FX.ur_v.conn, calcZone(S.zones[0]).cwPipe]`);
  assert.equal(r[0],20); assert.ok(r[1]>=20);
});

test('2-2·2-4 DFU — 주방싱크 3, 용도별 열, 빈칸은 표 4.1-3', ()=>{
  const app=load();
  const g=app.run(RESET+`return [dfuOf('sink'),dfuOf('wc_v'),dfuOf('ur_v'),dfuOf('shw'),dfuOf('bath'),dfuOf('cls'),dfuOf('fd_e')]`);
  assert.deepEqual(g,[3,4,4,2,2,3,0]);   // 욕조 일반 빈칸 → 트랩 DN40 = 2
  const a=app.run(RESET+`S.bldgUse='assembly'; return [dfuOf('wc_v'),dfuOf('ur_v'),dfuInfo('shw'),dfuInfo('cls'),dfuOf('bas_p')]`);
  assert.deepEqual(a,[6,5,{v:3,byTrap:true},{v:5,byTrap:true},1]);
  const m=app.run(RESET+`S.bldgUse='multi'; return [dfuOf('wc_t'),dfuInfo('ur_t')]`);
  assert.deepEqual(m,[3,{v:2,byTrap:true}]);
  // 다중이용 화장실 — 대변기 4·소변기 4 → 오수 44 DFU (일반이면 32)
  const s=app.run(RESET+`S.bldgUse='assembly';`+ZONE('A','1층',[['wc_v',4],['ur_v',4]])+`return calcZone(S.zones[0]).sewDFU`);
  assert.equal(s,44);
});

test('2-3 FD(상시배수) 삭제 — 옛 저장본은 FD(비상용)으로 바꾸고 알린다', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['shw',2],['fd_e',1]])+`
    const n=Object.values(S.zones[0].pipe.nodes).find(n=>n.fxKey==='fd_e'); n.fxKey='fd'; n.qty=3;
    normalizeState(); const w=LOAD_WARN.slice(); LOAD_WARN.length=0;
    return {keys:FX_KEYS.includes('fd'), fx:!!FX.fd, k:n.fxKey, w}`);
  assert.equal(r.keys,false); assert.equal(r.fx,false); assert.equal(r.k,'fd_e');
  assert.ok(r.w.some(x=>/FD\(상시배수/.test(x)&&/3개/.test(x)));
});

// 실제 불러오기 경로로 본다 — 종전 시험은 S.sizeRule 을 지우고 normalizeState() 만 불러 오류를 놓쳤다 (2026-11-25)
const SAVED=extra=>{ const app=load(); const s=app.run(RESET+ZONE('A','1층',[['wc_v',2]])+`const d=JSON.parse(JSON.stringify(S)); delete d.sizeRule; delete d.bldgUse; delete d.cwSizeMode; return d;`); return Object.assign(s,extra); };
const viaStorage=d=>{ const app=load(JSON.stringify(d)); return {app, ...app.run(`showLoadWarn(); return {mode:S.cwSizeMode,rule:S.sizeRule===SIZE_RULE,use:S.bldgUse}`), warn:app.alerts.join('\n')}; };
const viaFile=(d,before='')=>{ const app=load(); return {app, ...app.run(RESET+before+`
  globalThis.FileReader=function(){ this.readAsText=()=>this.onload({target:{result:${JSON.stringify(JSON.stringify(d))}}}); };
  loadJSON({target:{files:[{}],value:''}}); return {mode:S.cwSizeMode,rule:S.sizeRule===SIZE_RULE,use:S.bldgUse}`), warn:app.alerts.join('\n')}; };

test('U1 저장본 변환 — 브라우저 저장본·JSON 파일 모두 실제 경로로: 관균등표 → WSFU 와 알림, 유량 구간표는 유지', ()=>{
  for(const via of [viaStorage,viaFile]){
    for(const x of [{cwSizeMode:'equiv'},{},{cwSizeMode:'equiv',sizeRule:'CH-20261123-02'}]){   // 옛 저장본 · 더 옛 저장본 · 첫 배포본에서 변환 안 된 저장본
      const r=via(SAVED(x)); assert.equal(r.mode,'wsfu',JSON.stringify(x)); assert.equal(r.rule,true); assert.match(r.warn,/산정법이 바뀌었습니다/);
    }
    const f=via(SAVED({cwSizeMode:'flow'})); assert.equal(f.mode,'flow'); assert.doesNotMatch(f.warn,/산정법/);
    const w=via(SAVED({cwSizeMode:'wsfu',sizeRule:'CH-20261123-02'})); assert.equal(w.mode,'wsfu'); assert.doesNotMatch(w.warn,/산정법/);
    // 새 규칙으로 저장한 뒤 사용자가 고른 관균등표는 유지
    const k=via(SAVED({cwSizeMode:'equiv',sizeRule:load().run('return SIZE_RULE')})); assert.equal(k.mode,'equiv'); assert.doesNotMatch(k.warn,/산정법/);
  }
});

test('저장본에 없는 건물 용도는 지금 프로젝트 값을 물려받지 않는다', ()=>{
  const r=viaFile(SAVED({cwSizeMode:'equiv'}),`S.bldgUse='assembly';`); assert.equal(r.use,'general');
  const k=viaFile(SAVED({cwSizeMode:'equiv',bldgUse:'multi'}),`S.bldgUse='assembly';`); assert.equal(k.use,'multi');
});

test('1-2 최대압 — 550 kPa 이면 초과(KDS 4.7 「550 kPa 이상」), 549 는 적합', ()=>{
  const app=load();
  const r=app.run(RESET+`S.maxPressureKPa=550; const a=zoneSplitCheck().over; S.maxPressureKPa=549; const b=zoneSplitCheck().over; return [a,b]`);
  assert.deepEqual(r,[true,false]);
});

test('실패 사례 — 기구가 없으면 0, WSFU 10,000 초과는 표 끝값과 경고 표시', ()=>{
  const app=load();
  const r=app.run(RESET+ZONE('A','1층',[['fd_e',2]])+`const r=calcZone(S.zones[0]); return [r.cwPipe,r.cwQ,r.hwPipe]`);
  assert.deepEqual(r,[0,0,0]);
  const o=app.run(RESET+ZONE('A','1층',[['wc_v',2100]])+`const r=calcZone(S.zones[0]); return [r.wsOver,r.cwQ]`);
  assert.deepEqual(o,[true,2990]);
});

// ── CH-20261123-06 앱 간 값 옮기기 (00_현행기준/앱간_값옮기기_표기기준.md) ──
const TOWER=`{ const R={id:'R1',name:'입상관 1',floorIds:[],zoneIds:[]};
  for(let f=3;f>=1;f--){ const z=newZone(f+'층 화장실',f+'층'); let prev=z.pipe.rootId;
    for(const [k,q] of [['wc_v',4],['ur_v',4],['bas_p',4]]){ const n=newPipeNode('fixture'); n.fxKey=k; n.qty=q; z.pipe.nodes[n.id]=n; z.pipe.nodes[prev].mainNext=n.id; prev=n.id; }
    S.zones.push(z); const F={id:'F'+f,name:f+'층',zoneIds:[z.id]}; S.cw.floors.push(F); R.floorIds.push(F.id); }
  S.cw.risers.push(R); S.cw.main.riserIds.push('R1'); }`;

test('CH-20261124-05 — 「옮겨 적을 값 → 용량계산서 부스터」 상자(Q·H) 삭제, 결과 화면에 기준 코드 없음', ()=>{
  const app=load();
  const r=app.run(RESET+TOWER+`S.pressure.supplyKPa=360; renderPressureTab(); const p=document.getElementById('pressurePane').innerHTML;
    renderResult(); const m=document.getElementById('resultPanel').innerHTML; return {p,m,f:typeof xferBox+typeof pumpHead}`);
  assert.equal(r.f,'undefinedundefined');
  for(const h of [r.p,r.m]){ assert.ok(!h.includes('옮겨 적을 값')); assert.ok(!/(AC|WS|DR|HW)-0\d\d/.test(h)); }
});

test('06 받는 칸 표시와 안내 탭 순서표 — ← 카탈로그(P_op/P_max), 이 앱 단계 ①·⑤ 굵게', ()=>{
  const app=load();
  const r=app.run(RESET+TOWER+`S.pressure.supplyKPa=360; S.maxPressureKPa=500;
    renderPressureTab(); const p=document.getElementById('pressurePane').innerHTML;
    renderHelp(); const h=document.getElementById('helpPanel').innerHTML; return {p,h}`);
  assert.ok(r.p.includes('← 카탈로그(P_op)')); assert.ok(r.p.includes('← 카탈로그(P_max)'));
  assert.ok(r.p.includes('kgf/cm²'));
  assert.ok(r.h.includes('위생배관: 관경·압력검토')); assert.ok(!r.h.includes('Q 순간최대유량, H 필요 양정'));
  assert.ok(r.h.includes('1.1 저수조·급수펌프')); assert.ok(r.h.includes('1.2 덕트 정압'));
  assert.equal((r.h.match(/font-weight:700;background:rgba\(59,130,246,\.10\)/g)||[]).length,2);
});

test('구글 로그인 제거 — 로그인 스크립트·관문 없이 앱 화면이 바로 보인다 (2026-11-25 사용자 지시)', ()=>{
  assert.ok(!/accounts\.google\.com|MEPAuth|auth-gate|src="auth\.js/.test(html));
  assert.match(html,/<div id="app-content">/);
});

test('허용마찰 재사용 — 화장실 40개소에서도 결과 화면 한 번에 한 번만 구하고, 입력을 바꾸면 바로 새 값 (2026-11-25)', ()=>{
  const app=load();
  const r=app.run(RESET+`S.pressure.supplyKPa=500;
    for(let i=0;i<4;i++){ const R={id:'R'+i,name:'R'+i,floorIds:[],zoneIds:[]};
      for(let f=10;f>=1;f--){ const z=newZone(f+'층'+i,f+'층'); let prev=z.pipe.rootId;
        for(const k of ['wc_v','ur_v','bas_p']){ const n=newPipeNode('fixture'); n.fxKey=k; n.qty=2; z.pipe.nodes[n.id]=n; z.pipe.nodes[prev].mainNext=n.id; prev=n.id; }
        S.zones.push(z); const F={id:'F'+i+'_'+f,name:f+'층',zoneIds:[z.id]}; S.cw.floors.push(F); R.floorIds.push(F.id); }
      S.cw.risers.push(R); S.cw.main.riserIds.push(R.id); }
    let n=0; const org=allowFrictionCalc; allowFrictionCalc=()=>{ n++; return org(); };
    renderResult(); const a=n; n=0; renderPressureTab(); const b=n;
    const s1=allowFriction().s, p1=calcMainType('cw').cwPipe;
    S.pressure.supplyKPa=400; const s2=allowFriction().s, p2=calcMainType('cw').cwPipe;
    S.pressure.supplyKPa=500; const p3=calcMainType('cw').cwPipe;
    let depth; try{ calcZone(null); }catch(e){ depth=_afDepth; }
    allowFrictionCalc=org; return {a,b,s1,s2,p1,p2,p3,depth}`);
  assert.equal(r.a,1); assert.equal(r.b,1);
  assert.ok(r.s2<r.s1); assert.ok(r.p2>=r.p1); assert.equal(r.p3,r.p1);
  assert.equal(r.depth,0);   // 오류가 나도 재사용 범위가 닫힌다
});
