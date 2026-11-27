// 2026-11-27 유료화 (웹앱_유료화_기준.md, CH-20261127-02) 회귀 시험 — 실행: node --test tests/paywall.test.mjs
//   기존 관리 시트(라이선스 · 고객 · 구매신청 · 구독 · 의견)를 네 앱이 같이 쓴다. 새 시트·구글폼 없음.
//   ① 백엔드(apps-script/license.gs): 가짜 스프레드시트로 체험 7일 · 앱별 피드백 연장 · 구매신청 대기 · 기존 paid·all 줄
//   ② auth.js: 가짜 구글 로그인·가짜 서버로 자동 체험 · 배너 · 만료 결제 안내 · 신청·피드백 본문 · 이메일이 URL 에 안 실림
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const GS=fs.readFileSync(new URL('../apps-script/license.gs',import.meta.url),'utf8');
const AUTH=fs.readFileSync(new URL('../auth.js',import.meta.url),'utf8');
const HTML=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');

// ── 가짜 스프레드시트 ──
function fakeSS(tabs){
  const sheets={};
  const mk=(name,rows)=>{ const data=rows.map(r=>r.slice());
    const sh={name,data,getName:()=>name,
      getDataRange:()=>({getValues:()=>data.length?data.map(r=>r.slice()):[[]]}),
      getLastRow:()=>data.length, getLastColumn:()=>Math.max(0,...data.map(r=>r.length)),
      appendRow:r=>{ data.push(r.slice()); }, setFrozenRows(){},
      getRange:(r,c,nr,nc)=>({ setValue:v=>{ while(data.length<r) data.push([]); data[r-1][c-1]=v; },
        setValues:vs=>{ vs.forEach((row,i)=>row.forEach((v,j)=>{ while(data.length<r+i) data.push([]); data[r-1+i][c-1+j]=v; })); },
        getValues:()=>[data[r-1].slice(c-1,c-1+(nc||1))], setFontWeight(){}, setDataValidation(){} })};
    sheets[name]=sh; return sh; };
  for(const [n,rows] of Object.entries(tabs)) mk(n,rows);
  return {sheets, ss:{getSheetByName:n=>sheets[n]||null, insertSheet:n=>mk(n,[]), getSheets:()=>Object.values(sheets), toast(){}}};
}
const LIC=['이메일','앱','유형','발급일','만료일','메모'];
const ORD=['신청일시','이메일','신청앱','금액','입금자명','세금계산서','메모','처리상태'];
function loadGS(tabs, today, who='u@x.com'){
  const f=fakeSS(Object.assign({'라이선스':[LIC]},tabs)), mails=[];
  const RealDate=Date;
  class FakeDate extends RealDate{ constructor(...a){ if(a.length) super(...a); else super(today); } static now(){ return new RealDate(today).getTime(); } }
  const ctx={console, Date:FakeDate, JSON, Math, String, Number, Array, Object, RegExp, isNaN,
    SpreadsheetApp:{getActiveSpreadsheet:()=>f.ss, openById:()=>f.ss, getUi:()=>{throw new Error('no ui');}},
    LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},
    MailApp:{sendEmail:(to,s)=>mails.push(s)},
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>'Y',setProperty(){},deleteProperty(){}})},
    Utilities:{formatDate:(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`},
    ContentService:{createTextOutput:t=>({setMimeType(){return t;}}),MimeType:{JSON:1}},
    UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify({email:who,aud:'631559035777-ara2uhplj7ds41ehfrr97cef8jlj4rip.apps.googleusercontent.com',email_verified:'true',name:'홍길동'})})}};
  vm.createContext(ctx); vm.runInContext(GS,ctx);
  const call=(o)=>JSON.parse(vm.runInContext(`handle(${JSON.stringify(Object.assign({idToken:'t',appId:'sanitary'},o))})`,ctx));   // json() 이 문자열을 돌려준다(가짜 ContentService)
  return {f, mails, call, lic:()=>f.sheets['라이선스'].data};
}
const d=s=>new Date(s+'T00:00:00');
const PROFILE={action:'profile',company:'○○엔지니어링',years:'8~15년',role:'설계',pain:'손계산·엑셀 반복 작업',painDetail:'엑셀 다시 만듦',channel:'블로그·검색',consent:false};

test('백엔드 — 처음이면 「none」, trial 요청으로 첫날 포함 7일, 다른 앱은 줄이 따로', ()=>{
  const g=loadGS({},'2026-11-27T10:00:00');
  assert.equal(g.call({action:'check'}).status,'none');
  const t=g.call({action:'trial'}); assert.equal(t.status,'trial'); assert.equal(t.daysLeft,7);
  const r=g.call({action:'check'});
  assert.equal(r.status,'trial'); assert.equal(r.daysLeft,7); assert.equal(r.expires,'2026-12-03'); assert.equal(r.feedbackDone,false); assert.equal(r.price,40000);
  assert.equal(g.lic().length,2); assert.equal(g.lic()[1][1],'sanitary'); assert.equal(g.lic()[1][2],'trial');
  assert.equal(g.call({action:'trial'}).status,'trial'); assert.equal(g.lic().length,2);   // 다시 발급하지 않음
  g.call({action:'trial',appId:'valve'}); assert.equal(g.lic().length,3);
  g.call({action:'trial',appId:'duct'}); assert.equal(g.lic().length,4);                     // 덕트도 체험 대상
  assert.ok(g.mails.some(m=>m.includes('[체험 시작] sanitary')));
});

test('백엔드 — 7일째 마지막 날까지 쓰고 8일째 만료', ()=>{
  const row=['u@x.com','sanitary','trial',d('2026-11-27'),d('2026-12-03'),''];
  let r=loadGS({'라이선스':[LIC,row]},'2026-12-03T23:00:00').call({action:'check'}); assert.equal(r.status,'trial'); assert.equal(r.daysLeft,1);
  r=loadGS({'라이선스':[LIC,row]},'2026-12-04T09:00:00').call({action:'check'}); assert.equal(r.status,'expired'); assert.equal(r.approved,false);
});

test('백엔드 — 앱 안 피드백(고객 시트 항목)을 내면 그 앱만 7일 연장, 앱마다 1회, 만료 뒤에도 연장', ()=>{
  const tabs={'라이선스':[LIC,['u@x.com','sanitary','trial',d('2026-11-20'),d('2026-11-26'),''],['u@x.com','valve','trial',d('2026-11-20'),d('2026-11-26'),'']]};
  const g=loadGS(tabs,'2026-11-28T10:00:00');
  assert.equal(g.call({action:'check'}).status,'expired');
  const p=g.call(PROFILE); assert.equal(p.extendedDays,7); assert.equal(p.status,'trial'); assert.equal(p.feedbackDone,true);
  assert.equal(g.lic()[1][4].getDate(),3); assert.match(String(g.lic()[1][5]),/피드백연장\+7d/);
  const c=g.f.sheets['고객'].data[1]; assert.equal(c[0],'u@x.com'); assert.equal(c[2],'○○엔지니어링'); assert.equal(c[5],'손계산·엑셀 반복 작업');
  assert.equal(g.call(PROFILE).extendedDays,0);                                              // 같은 앱은 1회
  assert.equal(g.call(Object.assign({},PROFILE,{appId:'valve'})).extendedDays,7);           // 다른 앱은 따로
  const old=loadGS({'라이선스':[LIC,['u@x.com','sanitary','trial',d('2026-11-20'),d('2026-12-01'),' / 프로필연장+7d']]},'2026-11-28T10:00:00');
  assert.equal(old.call({action:'check'}).feedbackDone,true);                                // 종전 「프로필연장」 도 쓴 것으로
});

test('백엔드 — 평생이용권 신청은 구매신청 시트(입금대기), 만료 화면에 「확인 중」, 열리는 건 판매자가 paid 로 바꿀 때', ()=>{
  const g=loadGS({'라이선스':[LIC,['u@x.com','sanitary','trial',d('2026-11-01'),d('2026-11-07'),'']],'구매신청':[ORD]},'2026-11-28T10:00:00');
  assert.equal(g.call({action:'purchase',apps:'sanitary',amount:'40000',depositor:'홍길동'}).received,true);
  const o=g.f.sheets['구매신청'].data[1]; assert.equal(o[1],'u@x.com'); assert.equal(o[2],'sanitary'); assert.equal(o[3],'40000'); assert.equal(o[4],'홍길동'); assert.equal(o[7],'입금대기');
  let c=g.call({action:'check'}); assert.equal(c.status,'expired'); assert.equal(c.payPending,true);
  g.lic()[1][2]='paid'; g.lic()[1][4]='';                                                    // 판매자 정식 전환
  c=g.call({action:'check'}); assert.equal(c.status,'paid'); assert.equal(c.approved,true);
});

test('백엔드 — 기존 「라이선스」 paid·all 줄과 수동 등록 줄은 그대로 평생', ()=>{
  let g=loadGS({'라이선스':[LIC,['U@X.com','all','paid',d('2025-01-01'),'','종전 구매자']]},'2026-11-27T10:00:00');
  assert.equal(g.call({action:'check'}).status,'paid'); assert.equal(g.call({action:'check',appId:'hvac'}).status,'paid');
  g=loadGS({'라이선스':[LIC,['u@x.com','sanitary','paid','','','수동 등록']]},'2026-11-27T10:00:00');
  assert.equal(g.call({action:'check'}).status,'paid');
});

test('백엔드 — 덕트 앱 「의견 보내기」(로그인 없음)는 종전대로', ()=>{
  const g=loadGS({},'2026-11-27T10:00:00');
  const res=g.call({action:'feedback',appId:'duct',message:'좋아요',idToken:null});
  assert.equal(res.ok,true); assert.equal(g.f.sheets['의견'].data.length,2);
});

// ── auth.js 화면 흐름 (가짜 DOM) ──
function loadAuth(serverReplies){
  const els={}, fetches=[];
  const el=(id)=>{ const e={id, style:{}, _html:'', className:'', value:'', checked:false, textContent:'', children:[],
    set innerHTML(v){ this._html=v; }, get innerHTML(){ return this._html; },
    appendChild(c){ this.children.push(c); }, addEventListener(){}, remove(){ delete els[this.id]; } }; return e; };
  els['auth-gate']=el('auth-gate'); els['app-content']=el('app-content'); els['app-content'].style.display='none';
  let cb=null;
  // 등록된 요소 안의 html 에 그 id 가 있으면 그때 요소를 만든다 (입력칸·버튼 상자)
  const doc={ getElementById:id=>{ if(els[id]) return els[id]; for(const k of Object.keys(els)) if(els[k]._html&&els[k]._html.includes(`id="${id}"`)) return (els[id]=el(id)); return null; },
    getElementsByName:()=>[],
    createElement:()=>{ const e=el(''); return new Proxy(e,{ set(t,k,v){ t[k]=v; if(k==='id') els[v]=t; return true; } }); },
    head:{appendChild(){}}, body:{ insertBefore:(n)=>{ els[n.id]=n; }, appendChild:(n)=>{ if(n.id) els[n.id]=n; }, firstChild:null }, referrer:'' };
  const replies=serverReplies.slice();
  const ctx={ console, document:doc, location:{reload(){},search:''}, URLSearchParams, URL, alert(m){ throw new Error('alert: '+m); },
    navigator:{clipboard:{writeText:()=>Promise.resolve()}}, setTimeout:()=>0,
    atob:(b)=>Buffer.from(b,'base64').toString('binary'), escape, decodeURIComponent,
    google:{accounts:{id:{ initialize:(o)=>{cb=o.callback;}, renderButton(){}, disableAutoSelect(){} }}},
    fetch:(url,opt)=>{ fetches.push({url,opt}); const r=replies.shift(); return Promise.resolve({ok:true,text:()=>Promise.resolve(JSON.stringify(r))}); } };
  ctx.window=ctx; vm.createContext(ctx); vm.runInContext(AUTH,ctx);
  vm.runInContext(`MEPAuth.init({clientId:'c',apiUrl:'https://script.google.com/x',appId:'sanitary',appName:'위생배관',trialDays:7,bonusDays:7,priceSingle:40000,priceBundle:0,bankInfo:'카카오뱅크 3333-07-0554442 (최일권)'})`,ctx);
  const jwt='h.'+Buffer.from(JSON.stringify({email:'u@x.com'})).toString('base64')+'.s';
  const settle=async()=>{ for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r)); };
  const click=async(label)=>{ const b=els['mep-modal-actions'].children.find(x=>x.textContent.includes(label)); assert.ok(b,label); b.onclick(); await settle(); };
  return {els, fetches, run:c=>vm.runInContext(c,ctx), login:async()=>{ cb({credential:jwt}); await settle(); }, click, settle};
}
const bodies=a=>a.fetches.map(f=>JSON.parse(f.opt.body));

test('auth.js — 처음 로그인: 버튼 없이 체험 발급 → 계산 화면 + 배너, 이메일은 URL 에 없음', async ()=>{
  const a=loadAuth([{ok:true,approved:false,status:'none',trialAvailable:true},{ok:true,approved:true,status:'trial',daysLeft:7,expires:'2026-12-03'}]);
  assert.match(a.els['auth-gate'].innerHTML,/7일 무료/); assert.match(a.els['auth-gate'].innerHTML,/40,000원/);
  await a.login();
  assert.deepEqual(bodies(a).map(b=>b.action),['check','trial']);
  assert.equal(a.els['app-content'].style.display,'block'); assert.equal(a.els['auth-gate'].style.display,'none');
  const b=a.els['mep-banner'].innerHTML;
  assert.match(b,/무료 체험 <b>7일 남음<\/b>/); assert.match(b,/피드백 내면 7일 연장/); assert.match(b,/평생이용권 결제 안내/);
  for(const f of a.fetches){ assert.ok(!f.url.includes('u@x.com')); assert.ok(!f.url.includes('?')); }
});

test('auth.js — 결제한 사람은 배너 없음, 피드백 연장을 쓴 사람은 「적용됨」', async ()=>{
  let a=loadAuth([{ok:true,approved:true,status:'paid',daysLeft:null}]); await a.login();
  assert.equal(a.els['app-content'].style.display,'block'); assert.equal(a.els['mep-banner'],undefined);
  a=loadAuth([{ok:true,approved:true,status:'trial',daysLeft:3,feedbackDone:true,expires:'2026-12-01'}]); await a.login();
  assert.match(a.els['mep-banner'].innerHTML,/피드백 연장 적용됨/); assert.match(a.els['mep-banner'].innerHTML,/2026-12-01까지/);
});

test('auth.js — 만료: 계산 화면 대신 결제 안내(40,000원 · 피드백 연장 · 다시 확인), 신청 대기 표시, 「영구 무료」 없음', async ()=>{
  const a=loadAuth([{ok:true,approved:false,status:'expired',feedbackDone:false,payPending:true,price:40000}]); await a.login();
  const g=a.els['auth-gate'].innerHTML;
  assert.equal(a.els['app-content'].style.display,'none');
  for(const t of ['무료 체험이 끝났습니다','40,000원','평생이용권 결제 안내','피드백 보내고 7일 더 쓰기','입금을 확인하고 있습니다','다시 확인','다른 계정으로']) assert.ok(g.includes(t),t);
  assert.doesNotMatch(g+HTML+AUTH,/영구 무료|무료로 계속|평생 무료/);
});

test('auth.js — 평생이용권 신청: 이 앱 40,000원·입금자명, 세금계산서 발행 안 함 안내', async ()=>{
  const a=loadAuth([{ok:true,approved:false,status:'expired',feedbackDone:true},{ok:true,received:true}]); await a.login();
  a.run('MEPAuth.openPurchase()');
  const m=a.els['mep-modal'].innerHTML;
  assert.match(m,/40,000원/); assert.match(m,/다른 앱은 따로/); assert.match(m,/3333-07-0554442/); assert.match(m,/발행해 드릴 수 없습니다/);
  a.run(`document.getElementById('mep-f-depositor').value='홍길동'`);
  await a.click('입금했습니다');
  const p=bodies(a)[1]; assert.equal(p.action,'purchase'); assert.equal(p.apps,'sanitary'); assert.equal(p.amount,'40000'); assert.equal(p.depositor,'홍길동');
  assert.match(a.els['auth-gate'].innerHTML,/입금을 확인하고 있습니다/);
});

test('auth.js — 만료 뒤 피드백(고객 항목)을 보내 연장되면 바로 계산 화면으로', async ()=>{
  const a=loadAuth([{ok:true,approved:false,status:'expired',feedbackDone:false},{ok:true,approved:true,status:'trial',daysLeft:7,feedbackDone:true,extendedDays:7}]); await a.login();
  a.run('MEPAuth.openProfile()');
  const m=a.els['mep-modal'].innerHTML;
  for(const id of ['mep-f-company','mep-f-years','mep-f-role','mep-f-pain','mep-f-pain-detail','mep-f-channel','mep-f-consent']) assert.ok(m.includes(`id="${id}"`),id);
  assert.match(m,/앱마다 1회/);
  a.run(`document.getElementById('mep-f-company').value='○○엔지니어링'; document.getElementById('mep-f-pain').value='계통도 작도 시간';`);
  await a.click('보내고 7일 연장');
  const p=bodies(a)[1]; assert.equal(p.action,'profile'); assert.equal(p.company,'○○엔지니어링'); assert.equal(p.pain,'계통도 작도 시간');
  assert.equal(a.els['app-content'].style.display,'block'); assert.match(a.els['mep-banner'].innerHTML,/피드백 연장 적용됨/);
});

test('index.html — 로그인 관문과 판매 설정(앱별 40,000원 · 계좌 · 같은 백엔드 주소)', ()=>{
  assert.ok(HTML.includes('<div id="auth-gate"></div>')); assert.ok(HTML.includes('src="auth.js?v=5"'));
  assert.ok(HTML.includes('<div id="app-content" style="display:none;">'));
  assert.match(HTML,/appId:\s*"sanitary"/); assert.match(HTML,/priceSingle: 40000/); assert.match(HTML,/priceBundle: 0/);
  assert.match(HTML,/bankInfo:\s*"카카오뱅크 3333-07-0554442 \(최일권\)"/);
  assert.match(HTML,/AKfycbzOwmnJdBeqkH4QMdbQRagHXFnOA7sXnkQDmGeerVi4mYUF9WL_vB3C8LIq1-AZekQX/);
});
