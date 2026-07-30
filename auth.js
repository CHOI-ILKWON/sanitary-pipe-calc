/**
 * MEP Works 공통 인증 모듈
 *
 * 다른 앱에 붙일 때는 이 파일을 복사하고, index.html 에서
 *   <script src="auth.js?v=1"></script>
 *   MEPAuth.init({ appId:'valve', appName:'밸브 계통도', ... })
 * 두 줄만 넣으면 된다. 이 파일 자체는 앱마다 수정할 필요가 없다.
 *
 * 흐름
 *   구글 로그인(팝업) → 권한 조회
 *     · 권한 있음        → 앱 진입 (체험이면 잔여일 배너)
 *     · 권한 없음        → "무료로 시작" 한 번 누르면 즉시 체험 발급 + 진입
 *     · 만료             → 정식 이용 신청 화면
 *   체험 진입 직후       → 프로필 입력 유도 (입력하면 체험 연장)
 *   정식 이용 신청       → 계좌 안내 + 입금 통보 (사이트를 벗어나지 않는다)
 *
 * 구버전 백엔드({approved:true} 만 주는 스크립트)와도 동작한다.
 * 백엔드를 아직 안 올렸어도 기존 구매자는 그대로 들어올 수 있다.
 */
window.MEPAuth = (function () {
  'use strict';

  var cfg = null;
  var idToken = null;      // 메모리에만 둔다 (저장하지 않음)
  var state = null;        // 서버가 준 현재 권한 상태
  var email = null;

  // ═══════════════════════════════════════════════════
  //  공개 API
  // ═══════════════════════════════════════════════════

  function init(options) {
    cfg = Object.assign({
      clientId: '',
      apiUrl: '',
      appId: 'sanitary',
      appName: '앱',
      trialDays: 7,
      priceSingle: 100000,
      priceBundle: 199000,
      bankInfo: '',            // 예: '카카오뱅크 3333-00-0000000 (홍길동)'
      gateId: 'auth-gate',
      contentId: 'app-content',
      onEnter: null            // 진입 성공 시 호출 (앱 초기화가 필요하면)
    }, options || {});

    injectStyles();
    renderGate('signin');

    // 구글 스크립트 로딩을 기다린다
    waitFor(function () {
      return window.google && google.accounts && google.accounts.id;
    }, function () {
      google.accounts.id.initialize({
        client_id: cfg.clientId,
        callback: onGoogleLogin,
        auto_select: true            // 재방문자는 클릭 없이 통과
      });
      var box = document.getElementById('mep-signin-btn');
      if (box) {
        google.accounts.id.renderButton(box, {
          theme: 'outline', size: 'large', text: 'signin_with', width: 260
        });
      }
    });
  }

  function getEmail() { return email; }
  function getState() { return state; }

  // ═══════════════════════════════════════════════════
  //  로그인 → 권한 확인
  // ═══════════════════════════════════════════════════

  function onGoogleLogin(res) {
    idToken = res.credential;
    email = parseJwtEmail(idToken);
    setStatus('인증 확인 중…');

    api('check', {}).then(function (data) {
      state = normalize(data);
      route();
    }).catch(function (err) {
      renderGate('error', { message: err.message });
    });
  }

  /**
   * 구버전 백엔드 호환.
   * 옛 스크립트는 {approved:true} 만 주므로 status/daysLeft 가 없다.
   * 그 경우 만료 없는 정식으로 취급해서 기존 구매자가 막히지 않게 한다.
   */
  function normalize(d) {
    d = d || {};
    if (d.approved && !d.status) {
      return { approved: true, status: 'paid', type: 'paid', daysLeft: null, legacy: true };
    }
    if (!d.approved && !d.status) {
      return { approved: false, status: 'none', trialAvailable: true, legacy: true };
    }
    return d;
  }

  function route() {
    if (state.approved) return enterApp();
    if (state.status === 'expired') return renderGate('expired');
    return renderGate('trial-offer');
  }

  function enterApp() {
    var gate = document.getElementById(cfg.gateId);
    var content = document.getElementById(cfg.contentId);
    if (gate) gate.style.display = 'none';
    if (content) content.style.display = 'block';

    renderBanner();

    // 체험자에게 프로필을 아직 안 받았으면 한 번 권한다 (강제하지 않는다)
    if (state.status === 'trial' && state.profileDone === false) {
      setTimeout(function () { openProfile(true); }, 1200);
    }

    if (typeof cfg.onEnter === 'function') {
      try { cfg.onEnter(state); } catch (e) { /* 앱 초기화 실패가 인증을 막지 않게 */ }
    }
  }

  // ═══════════════════════════════════════════════════
  //  체험 발급
  // ═══════════════════════════════════════════════════

  function startTrial() {
    var btn = document.getElementById('mep-trial-btn');
    if (btn) { btn.disabled = true; btn.textContent = '준비 중…'; }

    api('trial', { channel: detectChannel(), ref: document.referrer || '' })
      .then(function (data) {
        state = normalize(data);
        if (state.approved) return enterApp();
        renderGate(state.status === 'expired' ? 'expired' : 'error',
          { message: data.message || '체험을 시작할 수 없습니다.' });
      })
      .catch(function (err) {
        renderGate('error', { message: err.message });
      });
  }

  /** 어디서 왔는지 자동 추정 — 사용자가 고르지 않아도 기본값이 남는다 */
  function detectChannel() {
    var q = new URLSearchParams(location.search);
    var utm = q.get('utm_source') || q.get('from');
    if (utm) return utm;
    var r = document.referrer || '';
    if (!r) return '';
    if (/naver/.test(r)) return '네이버';
    if (/google/.test(r)) return '구글검색';
    if (/youtube/.test(r)) return '유튜브';
    if (/instagram|threads/.test(r)) return '인스타/스레드';
    if (/choi-ilkwon|mepworks/.test(r)) return '소개사이트';
    try { return new URL(r).hostname; } catch (e) { return ''; }
  }

  // ═══════════════════════════════════════════════════
  //  게이트 화면
  // ═══════════════════════════════════════════════════

  function renderGate(mode, opts) {
    opts = opts || {};
    var gate = document.getElementById(cfg.gateId);
    if (!gate) return;
    gate.style.display = 'block';

    var html = '';

    if (mode === 'signin') {
      html =
        '<h2 class="mep-h2">' + esc(cfg.appName) + '</h2>' +
        '<p class="mep-sub">구글 계정으로 로그인하면 바로 시작합니다.<br>' +
        '처음이신 분은 <b>' + cfg.trialDays + '일 무료</b>로 전 기능을 쓰실 수 있습니다.</p>' +
        '<div id="mep-signin-btn" class="mep-center"></div>' +
        '<p class="mep-status" id="mep-status"></p>' +
        '<p class="mep-fine">계산 결과는 브라우저에만 저장되며 서버로 전송되지 않습니다.</p>';
    }

    else if (mode === 'trial-offer') {
      html =
        '<h2 class="mep-h2">' + esc(cfg.appName) + '</h2>' +
        '<p class="mep-sub"><b>' + esc(email) + '</b> 계정으로<br>' +
        cfg.trialDays + '일 무료 체험을 시작할 수 있습니다.</p>' +
        '<ul class="mep-list">' +
        '<li>전 기능 제한 없음 — 계통도·엑셀·PDF 모두 포함</li>' +
        '<li>카드 등록 없음, 자동 결제 없음</li>' +
        '<li>지금 진행 중인 실제 프로젝트로 써보시는 걸 권합니다</li>' +
        '</ul>' +
        '<button id="mep-trial-btn" class="mep-btn mep-btn-primary">' + cfg.trialDays + '일 무료로 시작하기</button>' +
        '<p class="mep-status" id="mep-status"></p>';
    }

    else if (mode === 'expired') {
      html =
        '<h2 class="mep-h2">체험 기간이 끝났습니다</h2>' +
        '<p class="mep-sub">그동안 입력하신 프로젝트 데이터는 <b>이 브라우저에 그대로 남아 있습니다.</b><br>' +
        '정식 이용으로 전환하시면 이어서 사용하실 수 있습니다.</p>' +
        '<button class="mep-btn mep-btn-primary" onclick="MEPAuth.openPurchase()">정식 이용 신청하기</button>' +
        '<p class="mep-fine">' + esc(email) + ' 로 로그인되어 있습니다.</p>';
    }

    else if (mode === 'error') {
      html =
        '<h2 class="mep-h2">잠시 문제가 있었습니다</h2>' +
        '<p class="mep-sub">' + esc(opts.message || '') + '</p>' +
        '<button class="mep-btn" onclick="location.reload()">다시 시도</button>' +
        '<p class="mep-fine">계속 안 되면 회신 주세요. 바로 확인하겠습니다.</p>';
    }

    gate.className = 'mep-gate';
    gate.innerHTML = '<div class="mep-card">' + html + '</div>';

    var tb = document.getElementById('mep-trial-btn');
    if (tb) tb.onclick = startTrial;
  }

  function setStatus(msg) {
    var el = document.getElementById('mep-status');
    if (el) el.textContent = msg || '';
  }

  // ═══════════════════════════════════════════════════
  //  상단 배너 (체험 잔여일)
  // ═══════════════════════════════════════════════════

  function renderBanner() {
    var old = document.getElementById('mep-banner');
    if (old) old.remove();
    if (state.status !== 'trial') return;      // 정식 이용자에게는 아무것도 안 띄운다

    var d = state.daysLeft;
    var urgent = (typeof d === 'number' && d <= 3);

    var bar = document.createElement('div');
    bar.id = 'mep-banner';
    bar.className = 'mep-banner' + (urgent ? ' mep-banner-urgent' : '');
    bar.innerHTML =
      '<span>무료 체험 <b>' + (d == null ? '진행 중' : '잔여 ' + d + '일') + '</b></span>' +
      (state.profileDone === false
        ? '<button class="mep-chip" onclick="MEPAuth.openProfile()">정보 입력하고 ' +
          (state.bonusDays || 7) + '일 연장</button>'
        : '') +
      '<button class="mep-chip mep-chip-solid" onclick="MEPAuth.openPurchase()">정식 이용 신청</button>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ═══════════════════════════════════════════════════
  //  프로필 입력
  // ═══════════════════════════════════════════════════

  function openProfile(auto) {
    var bonus = (state && state.bonusDays) || 7;
    modal(
      (auto ? '잠깐만요 — 체험을 ' + bonus + '일 늘려드립니다' : '이용자 정보'),
      '<p class="mep-sub" style="text-align:left">아래를 채워주시면 체험 기간이 <b>' + bonus + '일 연장</b>됩니다.<br>' +
      '어떤 실무에서 쓰이는지 알면 다음 기능을 더 잘 만들 수 있습니다.</p>' +
      '<div class="mep-form">' +
      row('회사 / 소속', '<input id="mep-f-company" class="mep-in" placeholder="○○엔지니어링">') +
      row('경력', '<select id="mep-f-years" class="mep-in">' +
        opt(['', '3년 미만', '3~7년', '8~15년', '16년 이상', '학생·수험생']) + '</select>') +
      row('담당 업무', '<input id="mep-f-role" class="mep-in" placeholder="기계설비 설계 / 감리 / 시공">') +
      // 이 문항이 마케팅 문구의 원천이 된다.
      // 드롭다운은 집계가 되고("반려가 40%"), 서술은 그대로 인용할 수 있는 문장이 된다.
      row('이 앱을 쓰기 전, 가장 번거로웠던 일', '<select id="mep-f-pain" class="mep-in">' +
        opt(['', '손계산·엑셀 반복 작업', '발주처 반려·재작업', '계통도 작도 시간',
             '기준·근거 찾기 어려움', '검토 실수 걱정', '기타']) + '</select>') +
      row('구체적으로 어떤 상황이었나요 (선택)',
        '<textarea id="mep-f-pain-detail" class="mep-in" rows="2" ' +
        'placeholder="예: 기구 수가 바뀔 때마다 엑셀을 처음부터 다시 만들어야 했습니다"></textarea>') +
      row('어떻게 알게 되셨나요', '<select id="mep-f-channel" class="mep-in">' +
        opt(['', '블로그·검색', '네이버 카페·지식iN', '유튜브', '지인 소개', '인스타·스레드', '소개 사이트', '기타']) + '</select>') +
      '</div>' +
      '<label class="mep-check"><input type="checkbox" id="mep-f-consent">' +
      '<span>새 기능·신규 앱 소식을 메일로 받겠습니다 <i>(선택, 언제든 해지 가능)</i></span></label>',
      [
        { label: '건너뛰기', cls: '', act: closeModal },
        { label: '저장하고 ' + bonus + '일 연장', cls: 'mep-btn-primary', act: submitProfile }
      ]
    );
  }

  function submitProfile() {
    var payload = {
      company: val('mep-f-company'),
      years:   val('mep-f-years'),
      role:    val('mep-f-role'),
      channel: val('mep-f-channel') || detectChannel(),
      pain: val('mep-f-pain'),
      painDetail: val('mep-f-pain-detail'),
      consent: !!(document.getElementById('mep-f-consent') || {}).checked
    };
    if (!payload.company) { alert('회사 / 소속만 꼭 채워주세요.'); return; }

    modalBusy('저장 중…');
    api('profile', payload).then(function (data) {
      state = normalize(data);
      closeModal();
      renderBanner();
      toast(data.extendedDays > 0
        ? '감사합니다. 체험이 ' + data.extendedDays + '일 연장되었습니다.'
        : '감사합니다. 저장되었습니다.');
    }).catch(function (err) {
      modalError(err.message);
    });
  }

  // ═══════════════════════════════════════════════════
  //  정식 이용 신청 (계좌이체)
  // ═══════════════════════════════════════════════════

  function openPurchase() {
    var single = won(cfg.priceSingle);
    var bundle = won(cfg.priceBundle);

    // priceBundle 이 0(또는 미설정)이면 전 앱 팩을 아예 보여주지 않는다.
    // 정하지 않은 가격이 고객 화면에 노출되지 않게 하려는 것 — 값을 넣으면 다시 나타난다.
    var plansHtml = cfg.priceBundle
      ? '<div class="mep-plans">' +
        '<label class="mep-plan"><input type="radio" name="mep-plan" value="single" checked>' +
        '<span><b>' + esc(cfg.appName) + '</b> 단품<i>' + single + '원</i></span></label>' +
        '<label class="mep-plan"><input type="radio" name="mep-plan" value="all">' +
        '<span><b>전 앱 팩</b> 유료 앱 전체<i>' + bundle + '원</i></span></label>' +
        '</div>'
      : '';   // 요금제 선택이 없으면 submitPurchase 의 기본값 'single' 이 그대로 쓰인다

    modal('정식 이용 신청',
      plansHtml +
      '<div class="mep-bank">' +
      '<div class="mep-bank-row"><span>입금 계좌</span>' +
      '<b id="mep-acct">' + esc(cfg.bankInfo || '(계좌 정보 미설정)') + '</b>' +
      '<button class="mep-chip" onclick="MEPAuth.copyAccount()">복사</button></div>' +
      '<div class="mep-bank-row"><span>입금 금액</span><b id="mep-amount">' + single + '원</b></div>' +
      '</div>' +
      '<div class="mep-form">' +
      row('입금자명', '<input id="mep-f-depositor" class="mep-in" placeholder="실제 입금하실 이름">') +
      row('메모 (선택)', '<input id="mep-f-memo" class="mep-in" placeholder="요청사항이 있으면">') +
      '</div>' +
      // 사업자 등록 전이라 증빙 발행이 불가능하다. 체크박스로 물어보면 발행되는 줄 알고
      // 결제한 뒤에 알게 되어 분쟁이 된다. 신청 전에 분명히 알리는 것이 맞다.
      '<p class="mep-notice">세금계산서·현금영수증은 <b>발행해 드릴 수 없습니다.</b><br>' +
      '개인 간 거래로 진행되며, 회사 경비 처리가 필요하시면 신청 전에 확인해 주세요.</p>' +
      '<p class="mep-fine" style="text-align:left">입금 확인 후 계정이 정식으로 전환됩니다(보통 하루 이내).<br>' +
      '전환되면 이 화면 없이 바로 사용하실 수 있습니다.</p>',
      [
        { label: '닫기', cls: '', act: closeModal },
        { label: '입금했습니다', cls: 'mep-btn-primary', act: submitPurchase }
      ]
    );

    // 요금제를 바꾸면 금액 표시도 바뀐다
    Array.prototype.forEach.call(document.getElementsByName('mep-plan'), function (r) {
      r.onchange = function () {
        var el = document.getElementById('mep-amount');
        if (el) el.textContent = won(r.value === 'all' ? cfg.priceBundle : cfg.priceSingle) + '원';
      };
    });
  }

  function submitPurchase() {
    var plan = 'single';
    Array.prototype.forEach.call(document.getElementsByName('mep-plan'), function (r) {
      if (r.checked) plan = r.value;
    });
    var depositor = val('mep-f-depositor');
    if (!depositor) { alert('입금자명을 입력해 주세요. 입금 확인에 필요합니다.'); return; }

    modalBusy('접수 중…');
    api('purchase', {
      apps: plan === 'all' ? 'all' : cfg.appId,
      amount: String(plan === 'all' ? cfg.priceBundle : cfg.priceSingle),
      depositor: depositor,
      memo: val('mep-f-memo')
      // taxInvoice 는 보내지 않는다 — 발행이 불가하므로 백엔드에서 항상 'N' 으로 기록된다.
      // 나중에 사업자 등록을 하면 체크박스를 되살리고 이 값을 다시 보내면 된다.
    }).then(function () {
      closeModal();
      toast('신청이 접수되었습니다. 입금 확인 후 바로 전환해 드리겠습니다.');
    }).catch(function (err) {
      modalError(err.message);
    });
  }

  function copyAccount() {
    var t = (cfg.bankInfo || '').replace(/[^0-9-]/g, '');
    copyText(t || cfg.bankInfo || '');
    toast('계좌번호를 복사했습니다.');
  }

  // ═══════════════════════════════════════════════════
  //  서버 통신
  // ═══════════════════════════════════════════════════

  /**
   * Apps Script 로 POST 한다.
   * Content-Type 을 text/plain 으로 보내는 이유: 이렇게 하면 브라우저가
   * preflight(OPTIONS)를 보내지 않는다. Apps Script 는 OPTIONS 를 처리할 수 없어서
   * application/json 으로 보내면 CORS 로 막힌다.
   * 이메일은 절대 URL 에 싣지 않는다 — 서버가 ID 토큰을 검증해서 직접 꺼낸다.
   */
  function api(action, payload) {
    var body = Object.assign({ action: action, appId: cfg.appId, idToken: idToken }, payload || {});
    return fetch(cfg.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) throw new Error('서버 응답 오류 (' + res.status + ')');
      return res.text();
    }).then(function (txt) {
      var data;
      try { data = JSON.parse(txt); }
      catch (e) { throw new Error('서버 응답을 해석할 수 없습니다.'); }
      if (data.ok === false && data.error === 'auth') {
        throw new Error('로그인이 만료되었습니다. 새로고침 후 다시 로그인해 주세요.');
      }
      return data;
    }).catch(function (err) {
      if (err instanceof TypeError) {
        throw new Error('인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
      throw err;
    });
  }

  // ═══════════════════════════════════════════════════
  //  UI 유틸 (모듈 안에서 자급자족 — 앱 CSS에 의존하지 않는다)
  // ═══════════════════════════════════════════════════

  function modal(title, bodyHtml, buttons) {
    closeModal();
    var wrap = document.createElement('div');
    wrap.id = 'mep-modal';
    wrap.className = 'mep-backdrop';
    wrap.innerHTML =
      '<div class="mep-card mep-modal-card">' +
      '<h3 class="mep-h3">' + esc(title) + '</h3>' +
      '<div id="mep-modal-body">' + bodyHtml + '</div>' +
      '<p class="mep-status" id="mep-modal-status"></p>' +
      '<div class="mep-actions" id="mep-modal-actions"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var box = document.getElementById('mep-modal-actions');
    (buttons || []).forEach(function (b) {
      var el = document.createElement('button');
      el.className = 'mep-btn ' + (b.cls || '');
      el.textContent = b.label;
      el.onclick = b.act;
      box.appendChild(el);
    });

    // 배경 클릭으로만 닫는다. 카드 안쪽 클릭이 닫아버리면 입력이 날아간다.
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) closeModal();
    });
  }

  function closeModal() {
    var m = document.getElementById('mep-modal');
    if (m) m.remove();
  }

  function modalBusy(msg) {
    var s = document.getElementById('mep-modal-status');
    if (s) { s.textContent = msg; s.className = 'mep-status'; }
    var acts = document.getElementById('mep-modal-actions');
    if (acts) Array.prototype.forEach.call(acts.children, function (b) { b.disabled = true; });
  }

  function modalError(msg) {
    var s = document.getElementById('mep-modal-status');
    if (s) { s.textContent = msg; s.className = 'mep-status mep-status-err'; }
    var acts = document.getElementById('mep-modal-actions');
    if (acts) Array.prototype.forEach.call(acts.children, function (b) { b.disabled = false; });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'mep-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  function row(label, field) {
    return '<label class="mep-row"><span>' + label + '</span>' + field + '</label>';
  }

  function opt(list) {
    return list.map(function (v) {
      return '<option value="' + esc(v) + '">' + (v || '선택해 주세요') + '</option>';
    }).join('');
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }

  function won(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function copyText(t) {
    if (navigator.clipboard) { navigator.clipboard.writeText(t); return; }
    var ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }

  function parseJwtEmail(token) {
    try {
      var b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(b)))).email || '';
    } catch (e) { return ''; }
  }

  function waitFor(cond, done, tries) {
    tries = tries == null ? 60 : tries;
    if (cond()) return done();
    if (tries <= 0) { setStatus('구글 로그인을 불러올 수 없습니다. 광고 차단 확장을 끄고 새로고침해 주세요.'); return; }
    setTimeout(function () { waitFor(cond, done, tries - 1); }, 150);
  }

  // ═══════════════════════════════════════════════════
  //  스타일
  // ═══════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById('mep-auth-css')) return;
    var s = document.createElement('style');
    s.id = 'mep-auth-css';
    s.textContent = [
      '.mep-gate{font:14px/1.6 -apple-system,"Malgun Gothic",sans-serif;color:#1a2a4a;padding:24px}',
      '.mep-card{max-width:460px;margin:72px auto;background:#fff;border:1px solid #e3e8f2;',
      '  border-radius:16px;padding:32px 28px;box-shadow:0 8px 32px rgba(30,50,90,.08);text-align:center}',
      '.mep-h2{font-size:20px;font-weight:700;margin:0 0 10px}',
      '.mep-h3{font-size:17px;font-weight:700;margin:0 0 14px;text-align:left}',
      '.mep-sub{color:#5a6b85;font-size:14px;margin:0 0 20px}',
      '.mep-fine{color:#8b98ad;font-size:12px;margin-top:16px}',
      '.mep-center{display:flex;justify-content:center}',
      '.mep-list{text-align:left;margin:0 0 22px;padding:16px 18px;background:#f6f8fc;border-radius:10px;',
      '  list-style:none;font-size:13px;color:#3d4d68}',
      '.mep-list li{padding:3px 0 3px 16px;position:relative}',
      '.mep-list li:before{content:"·";position:absolute;left:4px;color:#2563eb;font-weight:700}',
      '.mep-btn{font:inherit;font-weight:600;padding:11px 20px;border-radius:9px;border:1px solid #d0d8ee;',
      '  background:#fff;color:#3d4d68;cursor:pointer}',
      '.mep-btn:hover{background:#f4f6fb}',
      '.mep-btn:disabled{opacity:.55;cursor:default}',
      '.mep-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}',
      '.mep-btn-primary:hover{background:#1d4fd0}',
      '.mep-status{min-height:18px;font-size:13px;color:#5a6b85;margin-top:12px}',
      '.mep-status-err{color:#dc2626}',
      // 상단 배너
      '.mep-banner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 16px;',
      '  background:#eef3ff;border-bottom:1px solid #d3e0fb;font:13px -apple-system,"Malgun Gothic",sans-serif;',
      '  color:#1e3a8a;position:relative;z-index:200}',
      '.mep-banner-urgent{background:#fff4ed;border-bottom-color:#fcd9bd;color:#9a3412}',
      '.mep-chip{font:inherit;font-size:12px;font-weight:600;padding:5px 11px;border-radius:999px;',
      '  border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}',
      '.mep-chip:hover{background:rgba(0,0,0,.05)}',
      '.mep-chip-solid{background:#2563eb;border-color:#2563eb;color:#fff;margin-left:auto}',
      '.mep-chip-solid:hover{background:#1d4fd0}',
      // 모달
      '.mep-backdrop{position:fixed;inset:0;background:rgba(20,30,50,.45);z-index:9999;overflow-y:auto;',
      '  font:14px/1.6 -apple-system,"Malgun Gothic",sans-serif;color:#1a2a4a}',
      '.mep-modal-card{margin:48px auto;text-align:left;max-width:470px}',
      '.mep-form{display:flex;flex-direction:column;gap:11px;margin:4px 0 14px}',
      '.mep-row{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#5a6b85;font-weight:600}',
      '.mep-in{font:14px inherit;padding:9px 11px;border:1px solid #d0d8ee;border-radius:8px;',
      '  background:#fbfcfe;color:#1a2a4a;width:100%}',
      '.mep-in:focus{outline:none;border-color:#2563eb;background:#fff}',
      '.mep-check{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#5a6b85;margin:2px 0 4px}',
      '.mep-notice{font-size:12.5px;line-height:1.6;color:#8a5a1a;background:#fff8ed;border:1px solid #f5dcb8;',
      '  border-radius:8px;padding:10px 12px;margin:2px 0 4px;text-align:left}',
      '.mep-notice b{color:#9a3412}',
      '.mep-check i{color:#8b98ad;font-style:normal}',
      '.mep-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}',
      // 요금제 / 계좌
      '.mep-plans{display:flex;flex-direction:column;gap:8px;margin-bottom:16px}',
      '.mep-plan{display:flex;gap:10px;align-items:center;padding:12px 14px;border:1px solid #d0d8ee;',
      '  border-radius:10px;cursor:pointer}',
      '.mep-plan:has(input:checked){border-color:#2563eb;background:#f5f8ff}',
      '.mep-plan span{display:flex;width:100%;align-items:baseline;gap:6px;font-size:13px;color:#3d4d68}',
      '.mep-plan i{margin-left:auto;font-style:normal;font-weight:700;color:#1a2a4a}',
      '.mep-bank{background:#f6f8fc;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:13px}',
      '.mep-bank-row{display:flex;align-items:center;gap:8px;padding:3px 0}',
      '.mep-bank-row span{color:#5a6b85;min-width:64px;font-size:12px}',
      '.mep-bank-row b{color:#1a2a4a}',
      // 토스트
      '.mep-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;',
      '  background:#1a2a4a;color:#fff;padding:11px 18px;border-radius:10px;font:13px -apple-system,sans-serif;',
      '  box-shadow:0 6px 24px rgba(0,0,0,.2);max-width:90vw}',
      '@media print{.mep-banner,.mep-backdrop,.mep-toast{display:none!important}}'
    ].join('');
    document.head.appendChild(s);
  }

  return {
    init: init,
    openProfile: openProfile,
    openPurchase: openPurchase,
    copyAccount: copyAccount,
    getEmail: getEmail,
    getState: getState
  };
})();
