/**
 * MEP Works — 앱 라이선스 관리 백엔드 (Google Apps Script)
 *
 * 하나의 스프레드시트로 여러 앱의 체험/정식 권한을 관리한다.
 * 권한은 "행 단위"다 — 한 사람이 앱을 여러 개 사면 줄이 늘어난다.
 * 앱 이름을 'all' 로 넣은 줄은 전 앱 통과(번들 상품).
 *
 * ── 처리하는 요청 ──
 *  ping     : 배포 확인용 (브라우저에서 ?action=ping 으로 열어보면 됨)
 *  check    : 이 사람이 이 앱을 쓸 수 있는가 (앱 진입 시 매번)
 *  trial    : 체험 발급 (계정 × 앱 조합당 1회)
 *  profile  : 회사·연차·유입경로 등 프로필 저장 + 체험 연장 1회
 *  purchase : 정식 이용 신청 접수 + 관리자 메일 알림
 *
 * ── 시트 ──
 *  라이선스   이메일 | 앱 | 유형 | 발급일 | 만료일 | 메모      ← 권한의 원본
 *  고객       이메일 | 이름 | 회사 | 연차 | 직무 | 이전불편 | 불편상세 | 유입경로 | 수신동의 | 연장적용 | 갱신일
 *  구매신청   신청일시 | 이메일 | 신청앱 | 금액 | 입금자명 | 세금계산서 | 메모 | 처리상태
 *
 *  만료일이 비어 있으면 무기한이다.
 *  입금을 확인하면 라이선스 시트에서 유형을 paid 로 바꾸고 만료일을 비우면 된다.
 *
 * 기존 구글폼 응답 시트는 읽기만 한다(첫 실행 때 기존 구매자를 정식으로 1회 이관).
 * 절대 수정·삭제하지 않는다.
 */

// ═══════════════════════════════════════════════════════════
//  설정 — 이 부분만 본인 값으로 바꾸면 된다
// ═══════════════════════════════════════════════════════════
const CONFIG = {
  // 앱의 index.html 에 들어있는 것과 같은 값이어야 한다
  CLIENT_ID: '631559035777-ara2uhplj7ds41ehfrr97cef8jlj4rip.apps.googleusercontent.com',

  // 스프레드시트에 붙어있는 스크립트(스프레드시트 → 확장 프로그램 → Apps Script)면 비워둔다.
  // 독립 스크립트면 사용할 스프레드시트 ID 를 넣는다.
  //   시트 주소가  docs.google.com/spreadsheets/d/★★★/edit  이면 ★★★ 부분이 ID 다.
  SHEET_ID: '',

  // 체험 신청 / 구매 신청이 들어오면 알림 받을 주소
  ADMIN_EMAIL: 'jikwang8610@gmail.com',

  // 기본 체험 기간(일)
  TRIAL_DAYS: 7,

  // 프로필을 입력하면 추가로 주는 일수 (계정 × 앱 조합당 1회)
  TRIAL_BONUS_DAYS: 7,

  // 체험을 허용할 앱 목록. 여기 없는 앱 이름으로는 체험이 발급되지 않는다.
  TRIAL_APPS: ['sanitary', 'valve', 'fire', 'hvac'],

  // 기존 승인자를 이관할 때 줄 권한. 좁게 주고 필요한 사람만 올리는 게 안전하다.
  //   'sanitary' = 실제로 구매한 앱만 (권장)
  //   'all'      = 전 앱 통과
  // 개별로 전 앱을 열어줄 사람은 이관 후 「라이선스」 시트에서
  // 메뉴 → "선택한 줄 → 전 앱(all) 권한으로" 를 쓰면 된다.
  // (고객 이메일을 이 파일에 적지 말 것 — 이 파일은 깃 저장소에 올라간다.)
  LEGACY_APP: 'sanitary',

  // 관리자에게 메일 알림을 보낼지 (Apps Script 무료 한도: 하루 100통)
  NOTIFY: true,

  // 구버전 앱 호환. 옛 앱은 토큰 없이 ?email=... 로 조회하므로,
  // 이걸 켜두지 않으면 백엔드를 먼저 배포한 순간 기존 이용자가 전부 막힌다.
  // 새 앱(auth.js)을 배포하고 정상 동작을 확인한 뒤 false 로 바꾼다.
  ALLOW_LEGACY_EMAIL_CHECK: true
};

const SHEETS = {
  LICENSE: '라이선스',
  CUSTOMER: '고객',
  ORDER: '구매신청'
};

const HEADERS = {
  LICENSE: ['이메일', '앱', '유형', '발급일', '만료일', '메모'],
  CUSTOMER: ['이메일', '이름', '회사', '연차', '직무', '이전불편', '불편상세', '유입경로', '수신동의', '연장적용', '갱신일'],
  ORDER: ['신청일시', '이메일', '신청앱', '금액', '입금자명', '세금계산서', '메모', '처리상태']
};

// 「고객」 시트의 열 위치(0부터). 열을 추가하거나 옮기면 여기만 고치면 된다.
// 예전에 숫자를 코드 곳곳에 박아뒀다가 열이 하나 늘면서 집계가 엉뚱한 칸을 읽는 일이 있었다.
const C = {
  EMAIL: 0, NAME: 1, COMPANY: 2, YEARS: 3, ROLE: 4,
  PAIN: 5, PAIN_DETAIL: 6, CHANNEL: 7, CONSENT: 8, BONUS: 9, UPDATED: 10
};

// ═══════════════════════════════════════════════════════════
//  진입점
// ═══════════════════════════════════════════════════════════

function doGet(e) {
  return handle(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  var params = {};
  // 앱에서는 preflight(OPTIONS)를 피하려고 text/plain 으로 JSON 본문을 보낸다.
  // Apps Script 는 OPTIONS 를 처리할 수 없어서 이 방식이어야 브라우저에서 막히지 않는다.
  try {
    if (e && e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    }
  } catch (err) {
    // 본문이 JSON 이 아니면 폼 파라미터로 온 것으로 본다
  }
  if (e && e.parameter) {
    for (var k in e.parameter) {
      if (!(k in params)) params[k] = e.parameter[k];
    }
  }
  return handle(params);
}

function handle(p) {
  try {
    ensureSheets_();
    migrateLegacyOnce_();

    var action = String(p.action || 'check');

    if (action === 'ping') {
      // version 은 배포가 실제로 갱신됐는지 밖에서 확인하는 용도다. 코드를 고치면 같이 올린다.
      return json({ ok: true, version: '1.2', trialDays: CONFIG.TRIAL_DAYS, now: new Date().toISOString() });
    }

    // 구버전 앱 호환 경로.
    // 옛 앱은 토큰 없이 ?email=... 만 보낸다. 이 경우 조회만 허용하고
    // 옛 앱이 이해할 수 있는 모양({approved:...})으로만 답한다.
    // 보안 수준은 지금까지와 동일하다(더 나빠지지 않는다). 새 앱 전환이 끝나면 CONFIG 에서 끈다.
    if (CONFIG.ALLOW_LEGACY_EMAIL_CHECK && !p.idToken && !p.credential && p.email) {
      var legacyEmail = String(p.email).trim().toLowerCase();
      var legacy = checkAccess_(legacyEmail, normalizeAppId_(p.appId));
      return json({ approved: !!legacy.approved, legacy: true });
    }

    // 나머지 요청은 전부 로그인 검증이 필요하다
    var who = verifyToken_(p);
    if (!who) {
      return json({ ok: false, approved: false, error: 'auth', message: '로그인 정보를 확인할 수 없습니다. 다시 로그인해 주세요.' });
    }
    var email = who.email;
    // 이름은 구글 계정에서 자동으로 채운다 (사용자가 입력하지 않는다)
    if (!p.name && who.name) p.name = who.name;

    var appId = normalizeAppId_(p.appId);

    switch (action) {
      case 'check':    return json(checkAccess_(email, appId));
      case 'trial':    return json(startTrial_(email, appId, p));
      case 'profile':  return json(saveProfile_(email, appId, p));
      case 'purchase': return json(requestPurchase_(email, p));
      default:
        return json({ ok: false, error: 'unknown_action', message: '알 수 없는 요청입니다: ' + action });
    }
  } catch (err) {
    return json({ ok: false, approved: false, error: 'server', message: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
//  로그인 검증
// ═══════════════════════════════════════════════════════════

/**
 * 구글 ID 토큰을 구글 서버에 물어봐서 검증한 뒤 이메일과 이름을 꺼낸다.
 * 클라이언트가 보낸 이메일 문자열을 그대로 믿지 않는다 —
 * 그러면 아무나 남의 이메일로 권한을 조회/발급할 수 있다.
 * 이름은 구글 계정에 있는 값을 그대로 쓴다(사용자에게 따로 묻지 않는다).
 */
function verifyToken_(p) {
  var token = p.idToken || p.credential;
  if (!token) return null;

  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;

  var info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return null; }

  // 내 앱에 발급된 토큰인지, 이메일이 확인된 계정인지 확인
  if (!info.email) return null;
  if (info.aud !== CONFIG.CLIENT_ID) return null;
  if (String(info.email_verified) !== 'true') return null;

  return {
    email: String(info.email).trim().toLowerCase(),
    name: String(info.name || '').trim()
  };
}

function normalizeAppId_(v) {
  var s = String(v || 'sanitary').trim().toLowerCase();
  return s.replace(/[^a-z0-9_-]/g, '');
}

// ═══════════════════════════════════════════════════════════
//  권한 조회
// ═══════════════════════════════════════════════════════════

/**
 * 이 사람이 이 앱을 쓸 수 있는지 판단한다.
 * 같은 사람에게 여러 줄이 있으면 가장 좋은 것(정식 > 체험, 만료일이 늦은 것)을 고른다.
 */
function checkAccess_(email, appId) {
  var rows = readLicenseRows_();
  var today = startOfToday_();
  var best = null;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.email !== email) continue;
    if (r.app !== appId && r.app !== 'all') continue;

    var expired = r.expires && r.expires < today;
    var cand = {
      type: r.type,
      app: r.app,
      expires: r.expires,
      expired: expired,
      daysLeft: r.expires ? daysBetween_(today, r.expires) : null,
      score: (r.type === 'paid' ? 2000 : 1000) - (expired ? 5000 : 0) + (r.expires ? daysBetween_(today, r.expires) : 999)
    };
    if (!best || cand.score > best.score) best = cand;
  }

  if (!best) {
    return {
      ok: true, approved: false, status: 'none',
      trialAvailable: CONFIG.TRIAL_APPS.indexOf(appId) >= 0,
      trialDays: CONFIG.TRIAL_DAYS,
      bonusDays: CONFIG.TRIAL_BONUS_DAYS
    };
  }

  if (best.expired) {
    return {
      ok: true, approved: false, status: 'expired',
      type: best.type, expires: fmtDate_(best.expires),
      trialAvailable: false
    };
  }

  return {
    ok: true, approved: true,
    status: best.type === 'paid' ? 'paid' : 'trial',
    type: best.type,
    bundle: best.app === 'all',
    expires: best.expires ? fmtDate_(best.expires) : null,   // null = 무기한
    daysLeft: best.daysLeft,                                  // null = 무기한
    profileDone: hasProfile_(email)
  };
}

// ═══════════════════════════════════════════════════════════
//  체험 발급
// ═══════════════════════════════════════════════════════════

function startTrial_(email, appId, p) {
  if (CONFIG.TRIAL_APPS.indexOf(appId) < 0) {
    return { ok: false, approved: false, error: 'no_trial', message: '이 앱은 체험을 제공하지 않습니다.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 이미 권한이 있으면(체험이든 정식이든) 새로 발급하지 않는다 — 체험 무한 재발급 방지
    var current = checkAccess_(email, appId);
    if (current.approved) return current;
    if (current.status === 'expired') {
      return { ok: false, approved: false, status: 'expired', error: 'trial_used',
               message: '이미 체험을 사용하셨습니다. 정식 이용을 신청해 주세요.' };
    }
    // 만료된 줄이 없더라도 과거 이력이 있으면 재발급 금지
    if (hasAnyLicenseRow_(email, appId)) {
      return { ok: false, approved: false, error: 'trial_used',
               message: '이미 체험 이력이 있습니다. 정식 이용을 신청해 주세요.' };
    }

    var today = startOfToday_();
    var expires = addDays_(today, CONFIG.TRIAL_DAYS);
    var memo = [];
    if (p.channel) memo.push('유입:' + String(p.channel).slice(0, 40));
    if (p.ref)     memo.push('ref:' + String(p.ref).slice(0, 60));

    sheet_(SHEETS.LICENSE).appendRow([email, appId, 'trial', today, expires, memo.join(' / ')]);

    notify_('[체험 시작] ' + appId + ' — ' + email,
      '앱: ' + appId + '\n이메일: ' + email + '\n만료: ' + fmtDate_(expires) +
      (p.channel ? '\n유입경로: ' + p.channel : ''));

    return {
      ok: true, approved: true, status: 'trial', type: 'trial',
      expires: fmtDate_(expires),
      daysLeft: CONFIG.TRIAL_DAYS,
      profileDone: hasProfile_(email),
      bonusDays: CONFIG.TRIAL_BONUS_DAYS
    };
  } finally {
    lock.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════
//  프로필 저장 (+ 체험 연장 1회)
// ═══════════════════════════════════════════════════════════

function saveProfile_(email, appId, p) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(SHEETS.CUSTOMER);
    var values = sh.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === email) { rowIndex = i + 1; break; }
    }

    var alreadyBonused = rowIndex > 0 ? String(values[rowIndex - 1][C.BONUS]).toUpperCase() === 'Y' : false;

    // 수신동의는 반드시 사용자가 직접 체크한 값만 저장한다.
    // 광고성 메일은 사전 동의가 없으면 보낼 수 없다(정보통신망법).
    var consent = (p.consent === true || p.consent === 'true' || p.consent === 'Y') ? 'Y' : 'N';

    var row = [
      email,
      str_(p.name, 40),
      str_(p.company, 60),
      str_(p.years, 20),
      str_(p.role, 40),
      str_(p.pain, 40),          // 드롭다운 — 집계용
      str_(p.painDetail, 500),   // 서술 — 그대로 인용할 수 있는 문장
      str_(p.channel, 60),
      consent,
      alreadyBonused ? 'Y' : 'N',
      new Date()
    ];

    if (rowIndex > 0) {
      sh.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sh.appendRow(row);
      rowIndex = sh.getLastRow();
    }

    // 체험 연장은 계정당 1회
    var extended = 0;
    if (!alreadyBonused && CONFIG.TRIAL_BONUS_DAYS > 0) {
      extended = extendTrial_(email, appId, CONFIG.TRIAL_BONUS_DAYS);
      if (extended > 0) {
        sh.getRange(rowIndex, C.BONUS + 1).setValue('Y');
      }
    }

    notify_('[프로필 등록] ' + email,
      '회사: ' + (p.company || '-') + '\n연차: ' + (p.years || '-') +
      '\n직무: ' + (p.role || '-') + '\n유입경로: ' + (p.channel || '-') +
      '\n이전 불편: ' + (p.pain || '-') +
      (p.painDetail ? '\n  "' + p.painDetail + '"' : '') +
      '\n수신동의: ' + consent);

    var access = checkAccess_(email, appId);
    access.extendedDays = extended;
    return access;
  } finally {
    lock.releaseLock();
  }
}

function extendTrial_(email, appId, days) {
  var sh = sheet_(SHEETS.LICENSE);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var rowEmail = String(values[i][0]).trim().toLowerCase();
    var rowApp = String(values[i][1]).trim().toLowerCase();
    var rowType = String(values[i][2]).trim().toLowerCase();
    if (rowEmail !== email || rowApp !== appId || rowType !== 'trial') continue;

    var exp = toDate_(values[i][4]);
    if (!exp) return 0;                 // 무기한이면 연장할 것이 없다
    sh.getRange(i + 1, 5).setValue(addDays_(exp, days));
    sh.getRange(i + 1, 6).setValue(String(values[i][5] || '') + ' / 프로필연장+' + days + 'd');
    return days;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
//  정식 이용 신청
// ═══════════════════════════════════════════════════════════

function requestPurchase_(email, p) {
  var apps = p.apps;
  if (Array.isArray(apps)) apps = apps.join(',');
  apps = str_(apps || p.appId || '', 200);

  sheet_(SHEETS.ORDER).appendRow([
    new Date(),
    email,
    apps,
    str_(p.amount, 20),
    str_(p.depositor, 40),
    (p.taxInvoice === true || p.taxInvoice === 'true') ? 'Y' : 'N',
    str_(p.memo, 300),
    '입금대기'
  ]);

  notify_('[구매 신청] ' + email + ' — ' + apps,
    '이메일: ' + email +
    '\n신청 앱: ' + apps +
    '\n금액: ' + (p.amount || '-') +
    '\n입금자명: ' + (p.depositor || '-') +
    '\n세금계산서: ' + ((p.taxInvoice === true || p.taxInvoice === 'true') ? '필요' : '불필요') +
    '\n메모: ' + (p.memo || '-') +
    '\n\n입금을 확인하셨으면 「라이선스」 시트에서' +
    '\n  이메일=' + email + ' 줄의 유형을 paid 로, 만료일을 비우세요.' +
    '\n(전 앱 팩이면 앱 칸에 all 을 넣은 줄을 새로 추가하시면 됩니다.)');

  return { ok: true, received: true, message: '신청이 접수되었습니다. 입금 확인 후 안내드리겠습니다.' };
}

// ═══════════════════════════════════════════════════════════
//  시트 준비 / 기존 데이터 이관
// ═══════════════════════════════════════════════════════════

/**
 * 사용할 스프레드시트를 가져온다.
 * SHEET_ID 를 넣으면 그 시트를, 비워두면 스크립트가 붙어있는 시트를 쓴다.
 * 둘 다 없으면 어디에 쓸지 알 수 없으니 바로 알려준다.
 */
function ss_() {
  if (CONFIG.SHEET_ID) return SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('스프레드시트를 찾을 수 없습니다. 이 스크립트가 스프레드시트에 붙어있지 않다면 ' +
                    'CONFIG.SHEET_ID 에 사용할 스프레드시트 ID 를 넣어주세요.');
  }
  return active;
}

function ensureSheets_() {
  var ss = ss_();
  ensureSheet_(ss, SHEETS.LICENSE, HEADERS.LICENSE);
  ensureSheet_(ss, SHEETS.CUSTOMER, HEADERS.CUSTOMER);
  ensureSheet_(ss, SHEETS.ORDER, HEADERS.ORDER);
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sh;
  }
  // 시트는 있는데 비어 있으면 머리글만 넣는다 (기존 데이터는 건드리지 않는다)
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    return sh;
  }
  // 데이터 행이 아직 없으면 머리글을 최신 구성으로 맞춘다.
  // 열을 추가한 뒤 첫 배포 때 머리글만 옛 것으로 남는 것을 막는다.
  // 데이터가 한 줄이라도 있으면 절대 건드리지 않는다.
  if (sh.getLastRow() === 1 && sh.getLastColumn() <= headers.length) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function sheet_(name) {
  return ss_().getSheetByName(name);
}

/**
 * 기존 구글폼 응답 시트에 있던 구매자를 「라이선스」로 1회만 옮긴다.
 * 원본 시트는 읽기만 한다 — 수정·삭제하지 않는다.
 * 이관된 사람은 전 앱(all) / 정식(paid) / 무기한으로 처리한다.
 */
function migrateLegacyOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('legacyMigrated') === 'yes') return;

  var ss = ss_();
  var managed = [SHEETS.LICENSE, SHEETS.CUSTOMER, SHEETS.ORDER];
  var license = sheet_(SHEETS.LICENSE);
  var existing = {};
  var lic = license.getDataRange().getValues();
  for (var i = 1; i < lic.length; i++) {
    existing[String(lic[i][0]).trim().toLowerCase()] = true;
  }

  var moved = 0;
  var movedList = [];
  var skipped = [];
  var sheets = ss.getSheets();
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    if (managed.indexOf(sh.getName()) >= 0) continue;
    if (sh.getLastRow() < 2) continue;

    var values = sh.getDataRange().getValues();
    var emailCol = findEmailCol_(values);
    if (emailCol < 0) continue;

    // 승인 표시가 있는 열을 찾는다.
    // 구 스크립트는 이 열이 "승인" 인 사람만 통과시켰으므로, 이관도 같은 기준을 써야 한다.
    // 이 열을 못 찾으면 결제 안 한 사람까지 영구 무료가 되므로 그때는 아예 옮기지 않는다.
    var statusCol = findStatusCol_(values);
    if (statusCol < 0) {
      skipped.push(sh.getName() + ': 승인 열을 찾지 못해 건너뜀');
      continue;
    }

    for (var r = 1; r < values.length; r++) {
      var em = String(values[r][emailCol] || '').trim().toLowerCase();
      if (!em || em.indexOf('@') < 0) continue;
      if (String(values[r][statusCol]).trim() !== '승인') continue;   // 승인된 사람만
      if (existing[em]) continue;
      license.appendRow([em, CONFIG.LEGACY_APP, 'paid', startOfToday_(), '',
                         '기존 승인자 이관(' + sh.getName() + ') — 결제 확인 필요']);
      existing[em] = true;
      movedList.push(em);
      moved++;
    }
  }

  props.setProperty('legacyMigrated', 'yes');
  if (moved > 0 || skipped.length) {
    notify_('[이관 결과] 기존 승인자 ' + moved + '명 — 확인 필요',
      '기존 폼 응답 시트에서 상태가 "승인" 인 ' + moved + '명을\n' +
      '「라이선스」에 정식(' + CONFIG.LEGACY_APP + ' / 무기한)으로 옮겼습니다.\n' +
      '원본 시트는 수정하지 않았습니다.\n\n' +
      (movedList.length ? '옮긴 목록:\n  ' + movedList.join('\n  ') + '\n\n' : '') +
      (skipped.length ? '건너뛴 시트:\n  ' + skipped.join('\n  ') + '\n\n' : '') +
      '※ 구 방식은 폼 제출만으로 D열에 "승인" 이 자동 기입되던 구조입니다.\n' +
      '  즉 결제하지 않은 사람도 이 목록에 들어 있을 수 있습니다.\n' +
      '  실제 결제하신 분과 대조해서, 아닌 줄은 「라이선스」 시트에서 지우세요.\n' +
      '  (지금까지는 차단할 방법이 없었지만, 이관 후에는 줄을 지우면 차단됩니다.)');
  }
}

/** 이메일이 들어있는 열을 머리글로 찾는다 ("구글 이메일" 같은 이름도 잡는다) */
function findEmailCol_(values) {
  var header = values[0];
  for (var c = 0; c < header.length; c++) {
    var h = String(header[c]).toLowerCase();
    if (h.indexOf('email') >= 0 || h.indexOf('이메일') >= 0 || h.indexOf('메일') >= 0) return c;
  }
  // 머리글이 없으면 값에 @ 가 들어있는 열을 찾는다
  for (var c2 = 0; c2 < header.length; c2++) {
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][c2]).indexOf('@') > 0) return c2;
    }
  }
  return -1;
}

/**
 * 승인 상태 열을 찾는다.
 * 손으로 추가한 열은 머리글이 비어 있을 수 있으므로, 못 찾으면 값이 "승인" 인 열을 찾는다.
 */
function findStatusCol_(values) {
  var header = values[0];
  for (var c = 0; c < header.length; c++) {
    if (/상태|승인|approv/i.test(String(header[c]))) return c;
  }
  for (var c2 = 0; c2 < header.length; c2++) {
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][c2]).trim() === '승인') return c2;
    }
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════
//  보조 함수
// ═══════════════════════════════════════════════════════════

function readLicenseRows_() {
  var values = sheet_(SHEETS.LICENSE).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var email = String(values[i][0] || '').trim().toLowerCase();
    if (!email) continue;
    out.push({
      email: email,
      app: String(values[i][1] || '').trim().toLowerCase() || 'all',
      type: String(values[i][2] || '').trim().toLowerCase() === 'paid' ? 'paid' : 'trial',
      issued: toDate_(values[i][3]),
      expires: toDate_(values[i][4]),
      memo: String(values[i][5] || '')
    });
  }
  return out;
}

function hasAnyLicenseRow_(email, appId) {
  var rows = readLicenseRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].email === email && (rows[i].app === appId || rows[i].app === 'all')) return true;
  }
  return false;
}

function hasProfile_(email) {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === email) {
      return String(values[i][C.COMPANY] || '').trim() !== '';   // 회사 칸이 채워졌으면 입력한 것으로 본다
    }
  }
  return false;
}

function notify_(subject, body) {
  if (!CONFIG.NOTIFY || !CONFIG.ADMIN_EMAIL) return;
  try {
    MailApp.sendEmail(CONFIG.ADMIN_EMAIL, subject, body);
  } catch (e) {
    // 메일 한도를 넘겨도 권한 처리 자체는 계속되어야 한다
  }
}

function str_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 100);
}

function startOfToday_() {
  var d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays_(d, n) {
  var r = new Date(d.getTime());
  r.setDate(r.getDate() + n);
  return r;
}

function daysBetween_(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function fmtDate_(d) {
  if (!d) return null;
  return Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd');
}

// ═══════════════════════════════════════════════════════════
//  스프레드시트 메뉴 — 입금 확인 후 클릭으로 전환한다
//  (시트를 열면 상단에 「라이선스 관리」 메뉴가 생긴다)
// ═══════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi().createMenu('라이선스 관리')
    .addItem('선택한 줄 → 정식 전환 (무기한)', 'menuMakePaid')
    .addItem('선택한 줄 → 정식 전환 (1년)', 'menuMakePaidYear')
    .addItem('선택한 줄 → 차단', 'menuBlock')
    .addSeparator()
    .addItem('선택한 줄 → 전 앱(all) 권한으로', 'menuMakeAll')
    .addItem('선택한 줄 → 이 앱만(sanitary)', 'menuMakeSanitary')
    .addSeparator()
    .addItem('수신 동의자 목록 보기', 'menuSubscribers')
    .addItem('유입경로 집계 보기', 'menuChannels')
    .addItem('이전 불편 집계 + 실제 문장 보기', 'menuPains')
    .addSeparator()
    .addItem('시트 준비 / 기존 승인자 이관', 'setup')
    .addToUi();
}

function menuMakePaid()      { setRowsType_('paid', null); }
function menuMakePaidYear()  { setRowsType_('paid', 365); }
function menuBlock()         { setRowsType_(null, -1); }
function menuMakeAll()       { setRowsApp_('all'); }
function menuMakeSanitary()  { setRowsApp_('sanitary'); }

/** 선택한 줄의 「앱」 칸을 바꾼다. 'all' 이면 전 앱 통과. */
function setRowsApp_(appId) {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.LICENSE) {
    ui.alert('「' + SHEETS.LICENSE + '」 시트에서 실행해 주세요.');
    return;
  }

  var rng = sh.getActiveRange();
  var start = rng.getRow();
  if (start < 2) { ui.alert('머리글이 아니라 바꾸려는 데이터 줄을 선택해 주세요.'); return; }

  var n = 0;
  for (var i = 0; i < rng.getNumRows(); i++) {
    var row = start + i;
    if (!String(sh.getRange(row, 1).getValue() || '').trim()) continue;
    sh.getRange(row, 2).setValue(appId);
    n++;
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(n + '줄을 ' + appId + ' 권한으로 바꿨습니다.');
}

/**
 * 선택한 줄의 유형·만료일을 한 번에 바꾼다.
 *   days = null  → 만료일 비움(무기한)
 *   days = 365   → 오늘부터 1년
 *   days = -1    → 어제로 설정(즉시 차단)
 */
function setRowsType_(type, days) {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEETS.LICENSE) {
    ui.alert('「' + SHEETS.LICENSE + '」 시트에서 실행해 주세요.');
    return;
  }

  var rng = sh.getActiveRange();
  var start = rng.getRow();
  var count = rng.getNumRows();
  if (start < 2) {
    ui.alert('머리글이 아니라 바꾸려는 데이터 줄을 선택해 주세요.');
    return;
  }

  var changed = [];
  for (var i = 0; i < count; i++) {
    var row = start + i;
    var email = String(sh.getRange(row, 1).getValue() || '').trim();
    if (!email) continue;

    if (type) sh.getRange(row, 3).setValue(type);
    if (days === null)      sh.getRange(row, 5).setValue('');
    else if (days === -1)   sh.getRange(row, 5).setValue(addDays_(startOfToday_(), -1));
    else                    sh.getRange(row, 5).setValue(addDays_(startOfToday_(), days));

    changed.push(email + ' (' + sh.getRange(row, 2).getValue() + ')');
  }

  if (!changed.length) { ui.alert('바꿀 줄이 없습니다.'); return; }
  SpreadsheetApp.getActiveSpreadsheet().toast(
    changed.length + '줄 처리: ' + (days === -1 ? '차단' : '정식' + (days ? ' 1년' : ' 무기한')));
}

function menuSubscribers() {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][C.CONSENT]).toUpperCase() === 'Y') out.push(values[i][C.EMAIL]);
  }
  SpreadsheetApp.getUi().alert('수신 동의 ' + out.length + '명\n\n' + out.join('\n'));
}

/**
 * 이전 불편 집계 + 고객이 직접 쓴 문장.
 * 집계는 랜딩 페이지 헤드라인의 근거가 되고,
 * 서술 문장은 그대로 인용하면 내가 지어낸 문구보다 훨씬 잘 먹힌다.
 */
function menuPains() {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  var count = {};
  var quotes = [];
  for (var i = 1; i < values.length; i++) {
    var pain = String(values[i][C.PAIN] || '').trim() || '(미입력)';
    count[pain] = (count[pain] || 0) + 1;
    var detail = String(values[i][C.PAIN_DETAIL] || '').trim();
    if (detail) quotes.push('· "' + detail + '"  — ' + String(values[i][C.COMPANY] || '').trim());
  }
  var lines = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })
    .map(function (k) { return k + ' — ' + count[k] + '명'; });

  SpreadsheetApp.getUi().alert(
    '이전에 불편했던 것\n\n' + (lines.join('\n') || '아직 자료가 없습니다.') +
    (quotes.length ? '\n\n─── 직접 쓴 문장 ───\n' + quotes.join('\n') : ''));
}

function menuChannels() {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  var count = {};
  for (var i = 1; i < values.length; i++) {
    var ch = String(values[i][C.CHANNEL] || '').trim() || '(미입력)';
    count[ch] = (count[ch] || 0) + 1;
  }
  var lines = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })
    .map(function (k) { return k + ' — ' + count[k] + '명'; });
  SpreadsheetApp.getUi().alert('유입경로 집계\n\n' + (lines.join('\n') || '아직 자료가 없습니다.'));
}

// ═══════════════════════════════════════════════════════════
//  수동 실행용 — 편집기에서 직접 돌려볼 수 있다
// ═══════════════════════════════════════════════════════════

/** 시트 3장을 만들고 기존 구매자를 이관한다. 배포 전에 한 번 실행해 보면 좋다. */
function setup() {
  ensureSheets_();
  migrateLegacyOnce_();
  ss_().toast('시트 준비 완료');
}

/**
 * 외부 통신 권한(script.external_request)을 승인받기 위한 함수.
 *
 * 편집기에서 이 함수를 실행하면 권한 요청 창이 뜬다. 승인한 뒤 재배포하면 된다.
 * setup() 은 UrlFetchApp 을 쓰지 않아서, setup 만 실행하면 이 권한이 빠진 채로
 * 승인이 끝나고 로그인 검증 단계에서 "권한이 없습니다" 오류가 난다.
 * 하는 일은 구글 토큰 확인 주소에 요청 한 번 보내보는 것뿐이다.
 */
function authorize() {
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=test',
    { muteHttpExceptions: true }
  );
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { ui = null; }
  var msg = '외부 통신 권한 승인 완료 (응답 코드 ' + res.getResponseCode() + ').\n' +
            '이제 「배포 → 배포 관리 → 편집 → 새 버전 → 배포」 를 해주세요.';
  if (ui) { ui.alert(msg); } else { Logger.log(msg); }
}

/** 이관 플래그를 지운다. 이관을 다시 돌려야 할 때만 사용. */
function resetMigrationFlag() {
  PropertiesService.getScriptProperties().deleteProperty('legacyMigrated');
}

/** 수신 동의한 사람의 이메일 목록을 로그로 뽑는다 (뉴스레터 발송용). */
function listNewsletterSubscribers() {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][C.CONSENT]).toUpperCase() === 'Y') out.push(values[i][C.EMAIL]);
  }
  Logger.log('수신동의 ' + out.length + '명\n' + out.join(', '));
}

/** 유입경로별 집계 — 마케팅 채널 중 어디가 실제로 사람을 데려오는지 본다. */
function reportChannels() {
  var values = sheet_(SHEETS.CUSTOMER).getDataRange().getValues();
  var count = {};
  for (var i = 1; i < values.length; i++) {
    var ch = String(values[i][C.CHANNEL] || '(미입력)').trim() || '(미입력)';
    count[ch] = (count[ch] || 0) + 1;
  }
  var lines = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })
    .map(function (k) { return k + ': ' + count[k] + '명'; });
  Logger.log('유입경로 집계\n' + lines.join('\n'));
}
