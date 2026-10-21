// PRV 존 압력검토 (밸브 명세 7.3 prv 식·7.5, 2026-10-20) 회귀 시험 — 실행: node --test tests/prv-zone.test.mjs
// index.html 의 계산 스크립트를 DOM 스텁 위에서 그대로 돌린다. 관경은 바꾸지 않는지도 본다.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const src=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(t=>t.includes('const FX_KEYS'));

function load(){
  const el=()=>({innerHTML:'',value:'',style:{},addEventListener(){},classList:{toggle(){},add(){},remove(){}},
    querySelectorAll:()=>[],appendChild(){},setAttribute(){}});
  const els={};
  const ctx={console,Math,JSON,Date,setTimeout,clearTimeout,alert(){},confirm:()=>true,
    URL:{createObjectURL(){return ''},revokeObjectURL(){}},Blob:function(){},
    localStorage:{getItem(){return null},setItem(){},removeItem(){}},
    document:{getElementById:id=>els[id]||(els[id]=el()),querySelectorAll:()=>[],querySelector:()=>null,createElement:el,addEventListener(){},body:el()},
    navigator:{userAgent:''},location:{search:'',hash:''}};
  ctx.window=ctx; ctx.window.addEventListener=()=>{};
  vm.createContext(ctx);
  try{ vm.runInContext(src,ctx); }catch(e){ /* 초기화부의 DOM 의존은 무시 — 계산 함수는 이미 정의됨 */ }
  return {els,run:code=>{const v=vm.runInContext(code,ctx);return v===undefined?undefined:JSON.parse(JSON.stringify(v));}};
}

// 4층 사무동: 1층·4층에 세정밸브 대변기 화장실, 입상관 1개, 펌프 1층, 공급 500 kPa, 최대(정지양정) 650 kPa, 층고 4 m
function build(app,extra=''){
  app.run(`
    S.zones=[]; S.cw={floors:[],risers:[],main:{riserIds:[],floorIds:[],zoneIds:[]}};
    S.supplyType='booster'; S.mainLocation='bottom'; S.maxPressureKPa=650;
    S.pressure={supplyKPa:500,floorH:4,material:'stainless',mainLen:10,branchLen:8,zoneLen:3,minResidualKPa:55,fittingFactor:1.4};
    const mk=(name,floor)=>{ const z=newZone(name,floor); const n=newPipeNode('fixture'); n.fxKey='wc_v'; n.qty=3;
      z.pipe.nodes[n.id]=n; z.pipe.nodes[z.pipe.rootId].mainNext=n.id; S.zones.push(z); return z; };
    const z1=mk('1층 화장실','1층'), z4=mk('4층 화장실','4층');
    const f1={id:'F1',name:'1층',zoneIds:[z1.id]}, f4={id:'F4',name:'4층',zoneIds:[z4.id]};
    S.cw.floors.push(f4,f1);
    S.cw.risers.push({id:'R1',name:'입상관 1',floorIds:['F4','F1'],zoneIds:[],hLen:20});
    S.cw.main.riserIds.push('R1');
    ${extra}`);
}
const paths=app=>app.run(`calcAllPressurePaths('cw')`);
const byLabel=(ps,re)=>ps.find(p=>re.test(p.label));

test('PRV 없으면 종전과 같다 — 잔압 = 공급압 − 전 손실, 유량 0 최대압 = 최대공급 − 위치수두', ()=>{
  const app=load(); build(app);
  const ps=paths(app), p1=byLabel(ps,/1층 화장실/), p4=byLabel(ps,/4층 화장실/);
  assert.equal(p1.prv,undefined);
  assert.ok(Math.abs(p1.residual-(500-p1.totalLoss))<1e-9);
  assert.ok(Math.abs(p4.maxKPa-(650-3*4*9.81))<1e-6);
  assert.ok(Math.abs(p1.maxKPa-650)<1e-6);   // 1층: 650 > 550 — 저층 과압 (실패 조건)
});

test('B안 층 분기 PRV — 1층 잔압은 2차압에서 리셋, 상류(MAIN·입상관 수직) 손실 무관', ()=>{
  const app=load(); build(app,`S.cw.floors.find(f=>f.id==='F1').prvKPa=300;`);
  const p1=byLabel(paths(app),/1층 화장실/);
  assert.equal(p1.prv.kPa,300); assert.equal(p1.prv.short,false);
  const down=p1.segments.filter(g=>!g.upstream).reduce((s,g)=>s+g.friction+g.elev,0);
  assert.ok(Math.abs(p1.residual-(300-down))<1e-9);
  assert.deepEqual(p1.segments.map(g=>!!g.upstream),[true,true,false,false]);
  assert.equal(p1.maxKPa,300);                     // 유량 0: 2차압 그대로 (PRV 와 기구가 같은 층)
  assert.ok(Math.abs(p1.prvNeedKPa-(p1.reqKPa+down))<1e-9);
  // 4층 경로는 PRV 없음 — 영향 없음
  const p4=byLabel(paths(app),/4층 화장실/); assert.equal(p4.prv,undefined);
});

test('A안 입상관 시작 PRV — MAIN 만 상류, 입상관 수직 위치수두는 2차압에서 뺀다', ()=>{
  const app=load(); build(app,`S.cw.risers[0].prvKPa=400;`);
  const p4=byLabel(paths(app),/4층 화장실/);
  assert.deepEqual(p4.segments.map(g=>!!g.upstream),[true,false,false,false]);
  const down=p4.segments.slice(1).reduce((s,g)=>s+g.friction+g.elev,0);
  assert.ok(Math.abs(p4.residual-(400-down))<1e-9);
  assert.ok(Math.abs(p4.maxKPa-(400-3*4*9.81))<1e-6);
});

test('입상관 PRV + 층 분기 PRV 함께 — 마지막 PRV 가 기준, 1차압 = 입상관 2차압 − 사이 손실', ()=>{
  const app=load(); build(app,`S.cw.risers[0].prvKPa=400; S.cw.floors.find(f=>f.id==='F1').prvKPa=250;`);
  const p1=byLabel(paths(app),/1층 화장실/);
  assert.equal(p1.prv.kPa,250);
  const mid=p1.segments[1].friction+p1.segments[1].elev;
  assert.ok(Math.abs(p1.prv.inlet-(400-mid))<1e-9);
});

test('실패사례: 1차압 < 2차압 — PRV 는 올리지 못한다, 1차압으로 계산하고 표시', ()=>{
  const app=load(); build(app,`S.cw.floors.find(f=>f.id==='F4').prvKPa=480;`);   // 4층 1차 ≈ 500 − 118 − 마찰 < 480
  const p4=byLabel(paths(app),/4층 화장실/);
  assert.equal(p4.prv.short,true);
  assert.ok(p4.startKPa<480); assert.equal(p4.startKPa,p4.prv.inlet);
  assert.ok(Math.abs(p4.residual-(p4.prv.inlet-p4.downLoss))<1e-9);
});

test('실패사례: 2차압이 필요압+하류 손실보다 낮으면 잔압 부족(NG)', ()=>{
  const app=load(); build(app,`S.cw.floors.find(f=>f.id==='F1').prvKPa=90;`);   // 세정밸브 100 kPa 미만
  const p1=byLabel(paths(app),/1층 화장실/);
  assert.equal(p1.ok,false); assert.ok(p1.prvNeedKPa>90);
});

test('공급압 미입력이면 PRV 경로도 판정하지 않는다 (D15)', ()=>{
  const app=load(); build(app,`S.pressure.supplyKPa=null; S.cw.floors.find(f=>f.id==='F1').prvKPa=300;`);
  const p1=byLabel(paths(app),/1층 화장실/);
  assert.equal(p1.residual,null); assert.equal(p1.ok,null);
});

test('관경 불변 — PRV 입력은 관경 계산 결과를 바꾸지 않는다', ()=>{
  const app=load(); build(app);
  const before=app.run(`[calcRiser(S.cw.risers[0],'cw').cwPipe, ...S.cw.floors.map(f=>calcFloor(f,'cw').cwPipe), ...S.zones.map(z=>calcZone(z).cwPipe)]`);
  app.run(`S.cw.risers[0].prvKPa=400; S.cw.floors.find(f=>f.id==='F1').prvKPa=300;`);
  const after=app.run(`[calcRiser(S.cw.risers[0],'cw').cwPipe, ...S.cw.floors.map(f=>calcFloor(f,'cw').cwPipe), ...S.zones.map(z=>calcZone(z).cwPipe)]`);
  assert.deepEqual(after,before);
});

test('자동 상향은 PRV 상류 구간을 올리지 않는다', ()=>{
  const app=load(); build(app,`S.cw.floors.find(f=>f.id==='F1').prvKPa=101; S.cw.floors.find(f=>f.id==='F4').prvKPa=101;`);
  app.run(`solvePressureUpsize('cw')`);
  assert.equal(app.run(`+(S.cw.main.upsize||0)`),0);
  assert.equal(app.run(`+(S.cw.risers[0].upsize||0)`),0);
});

test('화면 렌더 — PRV 입력칸·리셋 행·유량 0 최대압·두 기준 병기, 오류 없음', ()=>{
  const app=load(); build(app,`S.cw.floors.find(f=>f.id==='F1').prvKPa=300;`);
  app.run(`renderPressureTab()`);
  const h=app.els.pressurePane.innerHTML;
  assert.match(h,/PRV 존 — 2차 설정압/);
  assert.match(h,/유량 0 최대/);
  assert.match(h,/294 kPa/);                 // 적정압 3.0 kgf/cm² 참고 병기
  assert.match(h,/PRV 존 적용 후 기구 최대압력/);
});
