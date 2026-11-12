// ===== الحساب والمزامنة مع فايربيس =====
// البيانات تبقى محفوظة على الجهاز أولًا (localStorage) كما كانت، وحين يدخل المستخدم بحسابه
// تُرفع كل علامة إلى Firestore وتُجلب تغييرات الأجهزة الأخرى لحظيًا.
// التخزين في القاعدة:  users/{uid}            ← { settings, t }
//                       users/{uid}/days/{يوم}  ← { d: بيانات اليوم, t: وقت التعديل }
import { firebaseConfig } from './firebase-config.js';

const V = '12.6.0';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;
const META_KEY = 'hafez-sync-v1';
const H = window.hafez; // الجسر إلى كود التطبيق في index.html

const box = document.getElementById('accountBox');
const badge = document.getElementById('syncBadge');

let fb = null;        // دوال فايربيس بعد تحميلها
let auth, db, user = null;
let unsubs = [];
let meta = loadMeta(); // آخر نسخة متزامنة: { uid, days: {يوم: json}, settings: json }
let pushTimer = null;

function loadMeta() {
  try { const m = JSON.parse(localStorage.getItem(META_KEY)); if (m && m.days) return m; } catch (e) {}
  return { uid: null, days: {}, settings: null };
}
const saveMeta = () => localStorage.setItem(META_KEY, JSON.stringify(meta));
const configured = () => firebaseConfig && firebaseConfig.apiKey && !/ضع/.test(firebaseConfig.apiKey);

// ===== التحميل =====
async function boot() {
  if (!configured()) return renderBox('off');
  renderBox('loading');
  try {
    const [app, a, f] = await Promise.all([
      import(`${CDN}/firebase-app.js`),
      import(`${CDN}/firebase-auth.js`),
      import(`${CDN}/firebase-firestore.js`),
    ]);
    fb = { ...app, ...a, ...f };
  } catch (e) {
    // أول فتح بلا إنترنت: يعمل التطبيق محليًا، وتعود المزامنة في الفتح التالي
    return renderBox('offline');
  }
  const app = fb.initializeApp(firebaseConfig);
  auth = fb.getAuth(app);
  auth.languageCode = 'ar';
  db = fb.initializeFirestore(app, {
    localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }),
  });
  fb.onAuthStateChanged(auth, onUser);
}

async function onUser(u) {
  unsubs.forEach(f => f()); unsubs = [];
  user = u;
  if (!u) { renderBox('signedOut'); setBadge(''); return; }
  renderBox('signedIn');
  setBadge('⏳');
  try {
    if (meta.uid !== u.uid) await firstLink(u);
    pushNow();
    listen(u);
    setBadge('☁️');
  } catch (e) {
    console.error(e);
    setBadge('⚠️');
    H.toast('تعذّرت المزامنة الآن، وستُعاد المحاولة تلقائيًا');
    listen(u);
  }
}

// ===== أول ربط لهذا الجهاز بالحساب: دمج بيانات الجهاز مع بيانات الحساب =====
async function firstLink(u) {
  const userRef = fb.doc(db, 'users', u.uid);
  const daysRef = fb.collection(db, 'users', u.uid, 'days');
  const [uSnap, dSnap] = await Promise.all([fb.getDocFromServer(userRef), fb.getDocsFromServer(daysRef)]);
  const state = H.getState();
  const cloud = {};
  dSnap.forEach(d => { cloud[d.id] = d.data().d || {}; });

  const conflicts = Object.keys(cloud).filter(k => state.days[k] && JSON.stringify(state.days[k]) !== JSON.stringify(cloud[k]));
  let preferCloud = true;
  if (conflicts.length) {
    preferCloud = confirm(
      `يختلف ${conflicts.length} يوم بين هذا الجهاز وحسابك.\n\n` +
      '«موافق»: اعتماد ما في الحساب لهذه الأيام\n«إلغاء»: اعتماد ما في هذا الجهاز');
  }
  for (const [k, d] of Object.entries(cloud)) {
    if (!state.days[k] || preferCloud) state.days[k] = d;
  }
  // ما في الحساب صار معروفًا، وما بقي مختلفًا يُرفع في pushNow
  meta = { uid: u.uid, days: {}, settings: null };
  for (const [k, d] of Object.entries(cloud)) meta.days[k] = JSON.stringify(d);

  if (uSnap.exists() && uSnap.data().settings) {
    const s = uSnap.data().settings;
    meta.settings = JSON.stringify(s);
    applySettings(s);
  }
  saveMeta();
  H.persist();
  H.refresh();
}

// ===== الرفع: يقارن الحالة بآخر نسخة متزامنة ويرفع الفرق فقط =====
function schedulePush() {
  if (!user) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 400);
}
function pushNow() {
  if (!user || !db) return;
  const state = H.getState();
  const ops = [];
  for (const [k, d] of Object.entries(state.days)) {
    const j = JSON.stringify(d);
    if (meta.days[k] !== j) ops.push(['set', k, d, j]);
  }
  for (const k of Object.keys(meta.days)) if (!(k in state.days)) ops.push(['del', k]);
  const sj = JSON.stringify(state.settings);
  const settingsChanged = meta.settings !== sj;
  if (!ops.length && !settingsChanged) return;

  const now = Date.now();
  // دفعات لا تتجاوز 450 عملية؛ وتُحفظ في ذاكرة فايربيس المحلية فورًا وتُرفع متى توفّر الاتصال
  for (let i = 0; i < Math.max(ops.length, 1); i += 450) {
    const batch = fb.writeBatch(db);
    for (const op of ops.slice(i, i + 450)) {
      const ref = fb.doc(db, 'users', user.uid, 'days', op[1]);
      if (op[0] === 'set') { batch.set(ref, { d: op[2], t: now }); meta.days[op[1]] = op[3]; }
      else { batch.delete(ref); delete meta.days[op[1]]; }
    }
    if (i === 0 && settingsChanged) {
      batch.set(fb.doc(db, 'users', user.uid), { settings: state.settings, t: now }, { merge: true });
      meta.settings = sj;
    }
    setBadge('⏳');
    batch.commit().then(() => setBadge('☁️')).catch(e => { console.error(e); setBadge('⚠️'); });
  }
  saveMeta();
}

// ===== الاستماع: تغييرات الأجهزة الأخرى تصل لحظيًا =====
function listen(u) {
  unsubs.push(fb.onSnapshot(fb.collection(db, 'users', u.uid, 'days'), snap => {
    const state = H.getState();
    let changed = false;
    snap.docChanges().forEach(ch => {
      if (ch.doc.metadata.hasPendingWrites) return; // تغيير من هذا الجهاز لم يُؤكَّد بعد
      const k = ch.doc.id;
      if (H.isEditing(k)) return;                   // لا نقاطع يومًا مفتوحًا للتعديل
      if (ch.type === 'removed') {
        if (k in state.days) { delete state.days[k]; changed = true; }
        delete meta.days[k];
        return;
      }
      const d = ch.doc.data().d || {};
      const j = JSON.stringify(d);
      meta.days[k] = j;
      if (JSON.stringify(state.days[k]) !== j) { state.days[k] = d; changed = true; }
    });
    saveMeta();
    if (changed) { H.persist(); H.refresh(); }
  }, e => { console.error(e); setBadge('⚠️'); }));

  unsubs.push(fb.onSnapshot(fb.doc(db, 'users', u.uid), snap => {
    if (snap.metadata.hasPendingWrites || !snap.exists() || !snap.data().settings) return;
    const s = snap.data().settings;
    const j = JSON.stringify(s);
    meta.settings = j; saveMeta();
    if (JSON.stringify(H.getState().settings) !== j) { applySettings(s); H.persist(); H.refresh(); }
  }));
}

function applySettings(s) {
  const state = H.getState();
  state.settings = { ...state.settings, ...s };
  H.applySettings();
}

// ===== الدخول والخروج =====
const ERR = {
  'auth/invalid-email': 'صيغة البريد غير صحيحة',
  'auth/missing-password': 'اكتب كلمة المرور',
  'auth/weak-password': 'كلمة المرور قصيرة؛ 6 أحرف على الأقل',
  'auth/email-already-in-use': 'هذا البريد مسجّل من قبل، ادخل به بدل إنشاء حساب',
  'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة',
  'auth/wrong-password': 'البريد أو كلمة المرور غير صحيحة',
  'auth/user-not-found': 'لا يوجد حساب بهذا البريد',
  'auth/too-many-requests': 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة',
  'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت',
  'auth/operation-not-allowed': 'الدخول بالبريد غير مفعّل في مشروع فايربيس',
  'auth/configuration-not-found': 'الدخول بالبريد غير مفعّل في مشروع فايربيس',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'إعدادات فايربيس غير صحيحة؛ راجع firebase-config.js',
};
const errText = e => ERR[e && e.code] || `حدث خطأ غير متوقع، أعد المحاولة (${(e && e.code) || 'unknown'})`;

function creds() {
  const email = document.getElementById('accEmail').value.trim();
  const pass = document.getElementById('accPass').value;
  return { email, pass };
}
async function run(btn, fn) {
  const msg = document.getElementById('accMsg');
  msg.textContent = ''; btn.disabled = true;
  try { await fn(); } catch (e) { msg.textContent = errText(e); }
  btn.disabled = false;
}
const actions = {
  signIn: btn => run(btn, () => { const c = creds(); return fb.signInWithEmailAndPassword(auth, c.email, c.pass); }),
  signUp: btn => run(btn, async () => {
    const c = creds();
    await fb.createUserWithEmailAndPassword(auth, c.email, c.pass);
    H.toast('أُنشئ حسابك، وبدأت المزامنة');
  }),
  reset: btn => run(btn, async () => {
    const c = creds();
    if (!c.email) throw { code: 'auth/invalid-email' };
    await fb.sendPasswordResetEmail(auth, c.email);
    document.getElementById('accMsg').textContent = 'أُرسل رابط تعيين كلمة المرور إلى بريدك';
  }),
  signOut: async btn => {
    if (!confirm('ستُزال بياناتك من هذا الجهاز وتبقى محفوظة في حسابك، وتعود حين تدخل من جديد. هل تريد الخروج؟')) return;
    btn.disabled = true;
    pushNow();
    const done = await Promise.race([
      fb.waitForPendingWrites(db).then(() => true),
      new Promise(r => setTimeout(() => r(false), 5000)),
    ]);
    if (!done && !confirm('بعض التغييرات لم تُرفع بعد لعدم وجود اتصال، والخروج الآن قد يُفقدها. هل تخرج رغم ذلك؟')) {
      btn.disabled = false; return;
    }
    unsubs.forEach(f => f()); unsubs = [];
    await fb.signOut(auth);
    meta = { uid: null, days: {}, settings: null }; saveMeta();
    H.clearLocal();
    H.toast('خرجت من حسابك');
  },
};

// ===== الواجهة =====
function setBadge(t) { if (badge) { badge.textContent = t; badge.title = { '☁️': 'متزامن مع حسابك', '⏳': 'جارٍ الرفع', '⚠️': 'تعذّرت المزامنة' }[t] || ''; } }

function renderBox(mode) {
  if (!box) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const views = {
    off: `<p class="muted" style="margin:0">المزامنة غير مفعّلة بعد؛ تُحفظ بياناتك على هذا الجهاز فقط.</p>`,
    loading: `<p class="muted" style="margin:0">جارٍ تحميل الحساب…</p>`,
    offline: `<p class="muted" style="margin:0">لا يوجد اتصال الآن؛ يعمل التطبيق على الجهاز، وتعود المزامنة حين يتوفّر الإنترنت.</p>`,
    signedOut: `
      <p class="muted" style="margin-top:0">ادخل بحسابك لتُحفظ بياناتك في السحابة وتظهر على كل أجهزتك.</p>
      <input class="field" id="accEmail" type="email" placeholder="البريد الإلكتروني" autocomplete="email" dir="ltr" style="margin-bottom:8px">
      <input class="field" id="accPass" type="password" placeholder="كلمة المرور" autocomplete="current-password" dir="ltr" style="margin-bottom:10px">
      <button class="btn primary" data-act="signIn">دخول</button>
      <button class="btn" data-act="signUp">إنشاء حساب جديد</button>
      <button class="btn" data-act="reset" style="border:none;color:var(--muted);margin:0">نسيت كلمة المرور؟</button>
      <p class="muted" id="accMsg" style="margin:6px 0 0;color:#dc2626"></p>`,
    signedIn: user ? `
      <div class="set-row" style="border:none;padding-top:0">
        <div><b>متصل بحسابك</b><div class="muted" dir="ltr" style="text-align:right">${esc(user.email || '')}</div></div>
        <span style="font-size:22px">☁️</span>
      </div>
      <p class="muted" style="margin-top:0">كل علامة تُرفع إلى حسابك تلقائيًا، وتعمل دون إنترنت ثم تُرفع حين يعود الاتصال.</p>
      <button class="btn" data-act="signOut">تسجيل الخروج</button>` : '',
  };
  box.innerHTML = views[mode] || '';
  box.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => actions[b.dataset.act](b); });
  const pass = document.getElementById('accPass');
  if (pass) pass.onkeydown = e => { if (e.key === 'Enter') box.querySelector('[data-act="signIn"]').click(); };
}

H.onSave = schedulePush;
boot();
