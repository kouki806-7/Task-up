/**
 * Daily Flow - Browser Task Manager
 * All data is stored locally in localStorage. No external API is used.
 */

const STORAGE_KEY = 'daily_flow_data';

// --- State Management ---
let state = {
    tasks: [],        // { id, text, duration, completed, isRoutine, tag, date }
    routines: [],     // { id, text, duration, tag }
    schedules: [],    // { id, gcalId, title, date, startTime, endTime, tag, memo }
    history: {},      // { 'YYYY-MM-DD': { rate, tasksTotal, tasksCompleted, memo, durationByTag } }
    memos: [],        // { id, text, createdAt, done }
    lastDate: '',     // 'YYYY-MM-DD'
    settings: {
        apiKey: 'AIzaSyDy-UDkVaLk5zLkojM3IOtzPZTwFpCtfSA',
        clientId: '402677092902-bceev6me91ekc1so00g2h96doqd1ripr.apps.googleusercontent.com',
        firebaseConfig: null,
        layoutMode: 'auto',
        googleEmail: null
    },
    timer: {
        taskId: null,
        startTime: null, // timestamp
        isRunning: false,
        accumulatedSeconds: 0
    },
    diary: {}    // { 'YYYY-MM-DD': { docId, webViewLink, localNote } }
};

function getTodayString() {
    const now = new Date();
    // Treat midnight–5am as still belonging to the previous day (schedule boundary)
    if (now.getHours() < 5) {
        const prevDay = new Date(now);
        prevDay.setDate(prevDay.getDate() - 1);
        return prevDay.toLocaleDateString('en-CA');
    }
    return now.toLocaleDateString('en-CA');
}

function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        state = JSON.parse(saved);
        if (!state.schedules) state.schedules = [];
        if (!state.tasks) state.tasks = [];
        if (!state.routines) state.routines = [];
        if (!state.history) state.history = {};
        if (!state.settings) {
            state.settings = {
                apiKey: 'AIzaSyDy-UDkVaLk5zLkojM3IOtzPZTwFpCtfSA',
                clientId: '402677092902-bceev6me91ekc1so00g2h96doqd1ripr.apps.googleusercontent.com',
                firebaseConfig: null,
                layoutMode: 'auto'
            };
        }
        if (!state.settings.layoutMode) state.settings.layoutMode = 'auto';
        if (!state.settings.googleEmail) state.settings.googleEmail = null;
        state.tasks.forEach(t => {
            if (!t.date) t.date = getTodayString();
        });
        if (!state.memos) state.memos = [];
        if (!state.timer) {
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };
        }
        if (!state.pausedTimers) state.pausedTimers = [];
        if (!state.calories) state.calories = {};
        if (!state.expenses) state.expenses = {};
        if (!state.diary) state.diary = {};
    }
    
    // Check for new day
    const today = getTodayString();
    if (state.lastDate !== today) {
        // Carry over incomplete non-routine tasks; routine tasks are regenerated fresh each day
        const carryOverTasks = state.tasks.filter(t => !t.completed && !t.isRoutine);
        const routineTasks = state.routines.map(r => ({
            id: generateId(),
            text: r.text,
            duration: r.duration,
            tag: r.tag || 'タスク',
            date: today,
            completed: false,
            isRoutine: true
        }));
        state.tasks = [...carryOverTasks, ...routineTasks];
        state.lastDate = today;
        saveData();
    }
}

function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (document.getElementById('view-dashboard').classList.contains('active')) {
        renderDashboard();
    }
    if (currentUser) {
        scheduleCloudSave();
    }
}

let _cloudSaveTimer = null;
function scheduleCloudSave() {
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    _cloudSaveTimer = setTimeout(() => {
        _cloudSaveTimer = null;
        saveToCloud();
    }, 2000);
}

function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

// --- DOM Elements ---
// Views
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-links li[data-view]');
// Dashboard
const formAdd = document.getElementById('add-task-form');
const inputName = document.getElementById('task-name');
const inputDuration = document.getElementById('task-duration');
const inputRoutine = document.getElementById('task-routine');
const inputTag = document.getElementById('task-tag');
const inputDate = document.getElementById('task-date');
const listActive = document.getElementById('active-task-list');
const listCompleted = document.getElementById('completed-task-list');
const countActive = document.getElementById('active-count');
const countCompleted = document.getElementById('completed-count');

// Progress
const dateDisplay = document.getElementById('current-date-display');
const progressRing = document.getElementById('daily-progress-ring');
const progressPercent = document.getElementById('daily-progress-percent');
const progressText = document.getElementById('progress-text');

// Smart Import
const inputGcal = document.getElementById('gcal-import');
const btnImport = document.getElementById('btn-import');

// History Calendar
const calendarMonthYear = document.getElementById('calendar-month-year');
const calendarDays = document.getElementById('calendar-days');
const btnPrevMonth = document.getElementById('prev-month');
const btnNextMonth = document.getElementById('next-month');
const historyDetailContent = document.getElementById('history-detail-content');
let currentCalendarDate = new Date();

// Stats View
const btnStatDaily = document.getElementById('btn-stat-daily');
const btnStatWeekly = document.getElementById('btn-stat-weekly');
const btnStatMonthly = document.getElementById('btn-stat-monthly');
const statsContent = document.getElementById('stats-content');

// Schedule View
const btnPrevWeek = document.getElementById('prev-week');
const btnNextWeek = document.getElementById('next-week');
const formSchedule = document.getElementById('add-schedule-form');
let currentWeekStart = new Date(); // Represents the currently selected date in schedule view

// Timer Elements
const btnTimerStart = document.getElementById('btn-timer-start');
const btnTimerPause = document.getElementById('btn-timer-pause');
const btnTimerFinish = document.getElementById('btn-timer-finish');
const btnTimerReset = document.getElementById('btn-timer-reset');
const btnTimerCancel = document.getElementById('btn-timer-cancel');
const timerDisplay = document.getElementById('timer-display');
const timerSelect = document.getElementById('timer-task-select');

function getMonday(d) {
  d = new Date(d);
  var day = d.getDay(),
      diff = d.getDate() - day + (day == 0 ? -6:1);
  return new Date(d.setDate(diff));
}

// --- Google API ---
let isSilentAuthAttempt = false;
const DISCOVERY_DOCS = [
    'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
];
// Calendar / Gmail scopes — kept separate from Drive so silent auth never fails
// due to a new drive.file consent requirement.
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;       // calendar + gmail
let driveTokenClient;  // drive.file only — used exclusively for diary doc creation
let driveAuthCallback = null;

let gapiInited = false;
let gisInited = false;
let authCallback = null;

function initGAPI() {
    if (window.gapi && state.settings && state.settings.apiKey) {
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    apiKey: state.settings.apiKey,
                    discoveryDocs: DISCOVERY_DOCS,
                });
                gapiInited = true;
            } catch(e) {
                console.error("GAPI init error", e);
                // gapi.client.init() throws when called a second time on an already-initialized
                // client. If calendar is already loaded, just update the API key and proceed.
                if (window.gapi && gapi.client && gapi.client.calendar) {
                    gapi.client.setApiKey(state.settings.apiKey);
                    gapiInited = true;
                } else {
                    // Discovery docs not loaded yet — try loading calendar directly
                    try {
                        gapi.client.setApiKey(state.settings.apiKey);
                        await gapi.client.load('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest');
                        gapiInited = true;
                    } catch(e2) {
                        console.error("GAPI fallback init error", e2);
                    }
                }
            }
        });
    } else if (!window.gapi && state.settings && state.settings.apiKey) {
        // gapi.js not yet loaded — retry once after a short delay
        setTimeout(initGAPI, 2000);
        return;
    }
    if (window.google && state.settings && state.settings.clientId) {
        // Main token client: calendar + gmail (used for all existing sync flows)
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: state.settings.clientId,
            scope: SCOPES,
            callback: (resp) => {
                if (resp.error !== undefined) {
                    if (!isSilentAuthAttempt) {
                        alert("認証エラー: " + resp.error);
                    } else {
                        console.log("[Auto-sync] silent auth result:", resp.error);
                    }
                    return;
                }
                if (authCallback) authCallback();
            },
        });
        // Drive token client: drive.file only — requested only when creating a diary doc
        driveTokenClient = google.accounts.oauth2.initTokenClient({
            client_id: state.settings.clientId,
            scope: DRIVE_SCOPE,
            callback: (resp) => {
                if (resp.error !== undefined) {
                    console.error('[Drive auth]', resp.error);
                    if (resp.error === 'interaction_required' || resp.error === 'access_denied') {
                        // Silent auth failed — show explicit consent/account-picker screen
                        driveTokenClient.requestAccessToken({ prompt: 'consent' });
                        return;
                    }
                    driveAuthCallback = null;
                    const btn = document.getElementById('btn-create-diary-doc');
                    if (btn) { btn.disabled = false; btn.textContent = '+ ドキュメントを作成'; }
                    return;
                }
                // GIS sets the token on gapi.client automatically, but only if
                // gapi.client is loaded. Explicit setToken() as a safety net.
                if (window.gapi && gapi.client) {
                    gapi.client.setToken(resp);
                }
                if (driveAuthCallback) {
                    const fn = driveAuthCallback;
                    driveAuthCallback = null;
                    fn();
                }
            },
        });
        gisInited = true;
    }
}

// --- Timer Logic ---
let timerInterval = null;

function formatTimer(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

const TRIVIA = [
    "空が青いのは、太陽の光が大気中の分子に当たって散乱し、波長の短い青い光が特に強く散乱されるからです（レイリー散乱）。",
    "キリンの舌はとても長く、45cmから50cmほどもあり、自分の耳を掃除することもできます。",
    "バナナは草の仲間で、木ではありません。また、イチゴはバラ科に属しています。",
    "金星の1日は、地球の1年よりも長いです。金星が自転する速さは非常にゆっくりです。",
    "人間の体の中で一番硬い組織は、歯のエナメル質です。",
    "タコには心臓が3つあり、脳も9つ（各腕に1つずつと中央に1つ）あります。",
    "世界で一番短い戦争は、イギリスとザンジバルの間で起きたもので、わずか38分で終わりました。",
    "宇宙には匂いがあると言われており、宇宙飛行士によると「焼けたステーキ」や「熱い金属」のような匂いがするそうです。",
    "クジラの心臓は非常に大きく、人間がその血管の中を泳げるほどのサイズのものもあります。",
    "ペンギンは膝を曲げて座っています。足が短いように見えますが、実は体の中に長い脚が隠れています。",
    "ミツバチは、1kgの蜂蜜を作るために、地球を約3周する距離を飛び回る必要があります。",
    "カメレオンの舌の長さは、自分の体の約2倍にもなります。",
    "アボカドは果物の一種ですが、脂肪分が多いため「森のバター」と呼ばれます。",
    "エッフェル塔は、夏になると熱膨張によって高さが約15cm高くなることがあります。",
    "マヨネーズはもともと、スペインのメノルカ島にあるマオンという町で作られたソース（マオンのソース）が語源です。",
    "地球の自転速度は徐々に遅くなっており、100年ごとに1日の長さが約2ミリ秒長くなっています。",
    "ナマケモノは泳ぐのが意外と得意で、地上よりも水中のほうが速く移動できます。",
    "シャチはイルカの仲間の中で最大の種です。",
    "富士山の山頂は、実は特定の県（静岡県や山梨県）に属しておらず、富士山本宮浅間大社の私有地です。",
    "トランプのカードの4人のキングは、それぞれ歴史上の有名な人物（アレキサンダー大王、カエサル、ダビデ王、シャルルマーニュ）がモデルと言われています。"
];

const PRAISES = [
    "お疲れ様でした！素晴らしい集中力です。",
    "完遂おめでとうございます！一歩前進ですね。",
    "ナイスワーク！この調子で頑張りましょう。",
    "やりきりましたね！自分を褒めてあげてください。",
    "集中お疲れ様でした。少し休憩も挟んでくださいね。"
];

function showTimerCompletionModal(taskName) {
    const modal = document.getElementById('timer-completion-modal');
    const title = document.getElementById('timer-praise-title');
    const taskEl = document.getElementById('completed-task-name');
    const trivia = document.getElementById('timer-trivia-content');
    
    if (modal) {
        title.textContent = PRAISES[Math.floor(Math.random() * PRAISES.length)];
        taskEl.textContent = taskName || "タスク完了";
        trivia.textContent = TRIVIA[Math.floor(Math.random() * TRIVIA.length)];
        modal.classList.add('active');
        
        createConfetti();
    }
}

function createConfetti() {
    const wrapper = document.getElementById('confetti-wrapper');
    if (!wrapper) return;
    wrapper.innerHTML = '';
    const colors = ['#f8fafc', '#6366f1', '#10b981', '#f59e0b', '#ef4444'];
    
    for (let i = 0; i < 40; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDelay = Math.random() * 0.5 + 's';
        piece.style.animationDuration = (Math.random() * 1.2 + 0.8) + 's';
        wrapper.appendChild(piece);
    }
}

function updateTimerSelect() {
    if (!timerSelect) return;
    
    // Restore selection: current value OR state-stored taskId
    const valToRestore = timerSelect.value || (state.timer ? state.timer.taskId : "");
    
    timerSelect.innerHTML = '<option value="">(タスクを選択してください)</option>';
    
    // 1. Get today's incomplete tasks + past incomplete tasks
    const todayStr = getTodayString();
    let tasksToShow = state.tasks.filter(t => !t.completed && t.date <= todayStr);
    
    // 2. If a timer is active, ensure THAT task is in the list (even if from another day or completed)
    if (state.timer && state.timer.taskId) {
        const timedTask = state.tasks.find(t => t.id === state.timer.taskId);
        if (timedTask && !tasksToShow.find(t => t.id === timedTask.id)) {
            tasksToShow.push(timedTask);
        }
    }
    
    tasksToShow.sort((a, b) => a.text.localeCompare(b.text));

    tasksToShow.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        const dateNote = t.date !== todayStr ? ` (${t.date.substring(5)})` : "";
        opt.textContent = t.text + dateNote;
        timerSelect.appendChild(opt);
    });
    
    if (valToRestore) {
        timerSelect.value = valToRestore;
    }
}

function updateTimerDisplay() {
    if (!state.timer || !timerDisplay) return;
    
    let totalSeconds = state.timer.accumulatedSeconds;
    if (state.timer.isRunning && state.timer.startTime) {
        const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
        totalSeconds += elapsed;
    }
    
    timerDisplay.textContent = formatTimer(totalSeconds);
}

function runTimerInterval() {
    if (timerInterval) clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(updateTimerDisplay, 1000);
}

function syncTimerUI() {
    if (!state.timer) return;
    
    if (state.timer.isRunning) {
        timerSelect.value = state.timer.taskId;
        timerSelect.disabled = true;
        btnTimerStart.innerHTML = '⏸ 一時停止';
        btnTimerStart.classList.replace('primary', 'secondary');
        btnTimerPause.style.display = 'none';
        btnTimerFinish.disabled = false;
        btnTimerCancel.style.display = 'block';
        if (btnTimerReset) btnTimerReset.style.display = 'block';
        runTimerInterval();
    } else if (state.timer.accumulatedSeconds > 0) {
        timerSelect.value = state.timer.taskId;
        timerSelect.disabled = false;
        btnTimerStart.innerHTML = '▶ 再開';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerFinish.disabled = false;
        btnTimerCancel.style.display = 'block';
        if (btnTimerReset) btnTimerReset.style.display = 'block';
        updateTimerDisplay();
    } else {
        timerSelect.disabled = false;
        btnTimerStart.innerHTML = '▶ 開始';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerCancel.style.display = 'none';
        if (btnTimerReset) btnTimerReset.style.display = 'none';
        updateTimerDisplay();
    }
    renderPausedTimers();
}

function renderPausedTimers() {
    const container = document.getElementById('paused-timers-list');
    if (!container) return;
    if (!state.pausedTimers || state.pausedTimers.length === 0) {
        container.innerHTML = '';
        return;
    }
    const items = state.pausedTimers.map(pt => {
        const task = state.tasks.find(t => t.id === pt.taskId);
        const name = task ? task.text : '(削除済みタスク)';
        return `<div class="paused-timer-item" onclick="resumePausedTimer('${pt.taskId}')">
            <span class="paused-timer-name">⏸ ${name}</span>
            <span class="paused-timer-time">${formatTimer(pt.accumulatedSeconds)}</span>
        </div>`;
    }).join('');
    container.innerHTML = `<p class="paused-timers-label">一時停止中のタスク</p>${items}`;
}

function stashCurrentTimer() {
    if (!state.timer.taskId || state.timer.accumulatedSeconds <= 0) return;
    const idx = state.pausedTimers.findIndex(t => t.taskId === state.timer.taskId);
    if (idx >= 0) {
        state.pausedTimers[idx].accumulatedSeconds = state.timer.accumulatedSeconds;
    } else {
        state.pausedTimers.push({ taskId: state.timer.taskId, accumulatedSeconds: state.timer.accumulatedSeconds });
    }
}

function resumePausedTimer(taskId) {
    if (state.timer.isRunning) {
        const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
        state.timer.accumulatedSeconds += elapsed;
        state.timer.isRunning = false;
        state.timer.startTime = null;
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
        stashCurrentTimer();
    } else if (state.timer.taskId && state.timer.taskId !== taskId && state.timer.accumulatedSeconds > 0) {
        stashCurrentTimer();
    }
    const idx = state.pausedTimers.findIndex(t => t.taskId === taskId);
    state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
    state.timer.taskId = taskId;
    state.timer.isRunning = true;
    state.timer.startTime = Date.now();
    updateTimerSelect();
    timerSelect.value = taskId;
    saveData();
    syncTimerUI();
}

// --- Firebase Sync ---
let db = null;
let auth = null;
let currentUser = null;
let _cloudFetchDone = false; // guard: fetch once per session, not on every auth token refresh

// True when local changes have not yet been pushed to Firestore
let hasPendingCloudSync = false;

function updateNetworkStatusUI() {
    const badge = document.getElementById('network-status');
    const label = document.getElementById('network-label');
    const banner = document.getElementById('offline-banner');

    if (navigator.onLine) {
        if (badge) badge.className = 'network-status-badge online';
        if (label) label.textContent = hasPendingCloudSync ? '同期待ち...' : 'オンライン';
        if (banner) banner.style.display = 'none';
    } else {
        if (badge) badge.className = 'network-status-badge offline';
        if (label) label.textContent = 'オフライン';
        if (banner) banner.style.display = 'flex';
    }
}

async function handleOnline() {
    updateNetworkStatusUI();
    // Push any locally-queued changes to Firestore when connection is restored
    if (hasPendingCloudSync && currentUser && db) {
        await saveToCloud();
    }
    updateNetworkStatusUI();
}

function initFirebase() {
    if (window.firebase && state.settings && state.settings.firebaseConfig) {
        try {
            if (!firebase.apps.length) {
                firebase.initializeApp(state.settings.firebaseConfig);
            }
            db = firebase.firestore();
            // Enable offline persistence so writes are queued locally when offline
            // and automatically synced when the connection is restored.
            db.enablePersistence({ synchronizeTabs: true }).catch(err => {
                // failed-precondition: multiple tabs open (only one tab gets persistence)
                // unimplemented: browser does not support IndexedDB
                if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
                    console.warn('Firestore persistence error:', err);
                }
            });
            auth = firebase.auth();
            
            // Listen to auth state
            auth.onAuthStateChanged(user => {
                const loggedOutDiv = document.getElementById('auth-logged-out');
                const loggedInDiv = document.getElementById('auth-logged-in');
                const avatar = document.getElementById('user-avatar');
                const name = document.getElementById('user-name');
                
                if (user) {
                    currentUser = user;
                    if(loggedOutDiv) loggedOutDiv.style.display = 'none';
                    if(loggedInDiv) loggedInDiv.style.display = 'flex';
                    if(avatar) avatar.src = user.photoURL || '';
                    if(name) name.textContent = user.displayName || 'ユーザー';

                    if (!_cloudFetchDone) {
                        _cloudFetchDone = true;
                        fetchCloudData();
                    }
                } else {
                    currentUser = null;
                    _cloudFetchDone = false; // allow fresh fetch on next login
                    if(loggedOutDiv) loggedOutDiv.style.display = 'block';
                    if(loggedInDiv) loggedInDiv.style.display = 'none';
                }
            });
        } catch (e) {
            console.error("Firebase init error", e);
        }
    }
}

async function fetchCloudData() {
    if (!db || !currentUser) return;
    try {
        const docRef = db.collection('users').doc(currentUser.uid);
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            const cloudState = docSnap.data();
            const today = getTodayString();
            const cloudDate = cloudState.lastDate || '';

            // ── Non-task state: always take from cloud ──
            state.routines   = cloudState.routines   || [];
            state.schedules  = cloudState.schedules  || [];
            state.history    = cloudState.history    || {};
            state.pausedTimers = cloudState.pausedTimers || [];
            state.calories   = cloudState.calories   || {};
            state.expenses   = cloudState.expenses   || {};
            state.memos      = cloudState.memos      || [];
            state.diary      = cloudState.diary      || {};
            if (cloudState.settings) {
                state.settings = { ...state.settings, ...cloudState.settings };
            }
            if (cloudState.timer) {
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                state.timer = cloudState.timer;
            }

            // ── Task reconciliation ──
            if (cloudDate < today) {
                // Cloud is from a previous day: apply new-day logic to cloud task list.
                const carryOver = (cloudState.tasks || []).filter(t => !t.completed && !t.isRoutine);
                const freshRoutines = state.routines.map(r => ({
                    id: generateId(), text: r.text, duration: r.duration,
                    tag: r.tag || 'タスク', date: today, completed: false, isRoutine: true
                }));
                state.tasks = [...carryOver, ...freshRoutines];
                state.lastDate = today;
            } else if (cloudDate === today) {
                // Cloud is current for today: merge to keep locally added tasks that
                // haven't reached the cloud yet (e.g. added within the 2-s debounce window).
                const cloudIds = new Set((cloudState.tasks || []).map(t => t.id));
                const localOnly = state.tasks.filter(t => !cloudIds.has(t.id));
                state.tasks = [...(cloudState.tasks || []), ...localOnly];
                state.lastDate = today;
            } else {
                // Cloud is ahead (multi-device edge case): trust cloud completely.
                state.tasks = cloudState.tasks || [];
                state.lastDate = cloudState.lastDate;
            }

            // Persist the reconciled state and push to cloud
            saveData();

            // Re-render
            renderDashboard();
            syncTimerUI();
            if (document.getElementById('view-history').classList.contains('active')) renderHistoryCalendar();
            if (document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();

            const syncStatus = document.getElementById('sync-status');
            if (syncStatus) {
                syncStatus.textContent = '同期済 ✓';
                syncStatus.style.color = 'var(--success-color)';
            }
        } else {
            // First login — upload local data to cloud
            saveToCloud();
        }
    } catch (e) {
        console.error("Error fetching cloud data", e);
    }
}

async function saveToCloud() {
    if (!db || !currentUser) return;
    try {
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期中...';
            syncStatus.style.color = 'var(--text-secondary)';
        }
        
        const dataToSave = {
            tasks: state.tasks,
            routines: state.routines,
            schedules: state.schedules,
            history: state.history,
            lastDate: state.lastDate,
            settings: state.settings,
            timer: state.timer,
            pausedTimers: state.pausedTimers,
            calories: state.calories,
            expenses: state.expenses,
            memos: state.memos,
            diary: state.diary
        };
        await db.collection('users').doc(currentUser.uid).set(dataToSave);

        hasPendingCloudSync = false;
        if (syncStatus) {
            syncStatus.textContent = '同期済 ✓';
            syncStatus.style.color = 'var(--success-color)';
        }
        updateNetworkStatusUI();
    } catch (e) {
        console.error("Error saving to cloud", e);
        hasPendingCloudSync = true;
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期失敗 ✕';
            syncStatus.style.color = 'var(--danger-color)';
        }
        updateNetworkStatusUI();
    }
}

// --- Weather Fetch ---
function isRainCode(c) {
    return (c >= 51 && c <= 65) || (c >= 80 && c <= 82) || c >= 95;
}

async function fetchWeather() {
    const weatherDisplay = document.getElementById('weather-display');
    if (!weatherDisplay) return;

    const lat = 35.6895;
    const lon = 139.6917;

    try {
        // Request current weather + hourly precipitation & weathercode for 2 days
        // (2 days ensures we always have 12 hours ahead even late at night)
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
            + `&current_weather=true`
            + `&hourly=precipitation,weathercode`
            + `&timezone=Asia%2FTokyo&forecast_days=2`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();

        const code = data.current_weather.weathercode;

        let icon = '🌤️';
        let desc = '不明';
        if (code === 0)                        { icon = '☀️';  desc = '快晴'; }
        else if (code <= 3)                    { icon = '⛅';  desc = '晴れ/曇り'; }
        else if (code === 45 || code === 48)   { icon = '🌫️'; desc = '霧'; }
        else if (code >= 51 && code <= 55)     { icon = '🌧️'; desc = '霧雨'; }
        else if (code >= 61 && code <= 65)     { icon = '☔';  desc = '雨'; }
        else if (code >= 71 && code <= 75)     { icon = '⛄';  desc = '雪'; }
        else if (code >= 80 && code <= 82)     { icon = '🌦️'; desc = 'にわか雨'; }
        else if (code >= 85 && code <= 86)     { icon = '🌨️'; desc = '雪'; }
        else if (code >= 95)                   { icon = '⛈️'; desc = '雷雨'; }

        // ── 12-hour rain forecast ──
        const times  = data.hourly.time;          // "YYYY-MM-DDTHH:00"
        const precip = data.hourly.precipitation; // mm
        const hCode  = data.hourly.weathercode;

        // Find the index for the current hour
        const now = new Date();
        const padZ = n => String(n).padStart(2, '0');
        const currentHourStr = `${now.getFullYear()}-${padZ(now.getMonth()+1)}-${padZ(now.getDate())}T${padZ(now.getHours())}:00`;
        const curIdx = times.indexOf(currentHourStr);

        let rainBadgeHtml = '';
        if (curIdx !== -1) {
            // Look at hours +1 … +12 (skip the current hour; weather icon already covers it)
            let rainOffset = -1;
            for (let i = 1; i <= 12; i++) {
                const idx = curIdx + i;
                if (idx >= times.length) break;
                if (precip[idx] > 0 || isRainCode(hCode[idx])) {
                    rainOffset = i;
                    break;
                }
            }

            if (rainOffset !== -1) {
                const label = rainOffset === 1 ? '約1時間後' : `約${rainOffset}時間後`;
                rainBadgeHtml = `<span class="rain-forecast-badge" title="${label}に雨の予報">☔ ${label}</span>`;
            }
        }

        weatherDisplay.innerHTML = `<span title="${desc} (${data.current_weather.temperature}℃)">${icon}</span>${rainBadgeHtml}`;
    } catch (e) {
        console.error("Weather fetch failed:", e);
        weatherDisplay.innerHTML = '☁️';
        weatherDisplay.title = '天気情報が取得できませんでした';
    }
}

// --- Initialization ---
function init() {
    loadData();
    applyLayoutMode();
    setupEventListeners();
    
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        // Only proceed if width actually changed (prevents issues with mobile address bars)
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;

        if (state.settings && state.settings.layoutMode === 'auto') {
            const changed = applyLayoutMode();
            if (changed && document.getElementById('view-schedule').classList.contains('active')) {
                renderWeeklySchedule();
            }
        }
    });

    // Set today's display date
    const today = new Date();
    dateDisplay.textContent = today.toLocaleDateString('ja-JP', { weekday: 'short', month: 'long', day: 'numeric' });
    
    renderDashboard();
    fetchWeather();
    syncTimerUI();

    // Network status listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', updateNetworkStatusUI);
    updateNetworkStatusUI();

    // Delay slightly to ensure external scripts are loaded, then attempt auto-sync
    setTimeout(() => {
        initGAPI();
        initFirebase();
        // After GAPI has had time to initialize, attempt background sync
        setTimeout(autoSyncGoogleCalendar, 3000);
    }, 1000);
}

// --- Navigation ---
function switchView(viewId) {
    views.forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewId}`).classList.add('active');
    
    navLinks.forEach(link => {
        if (link.dataset.view === viewId) link.classList.add('active');
        else link.classList.remove('active');
    });

    if (viewId === 'dashboard') {
        renderDashboard();
    } else if (viewId === 'history') {
        renderHistoryCalendar();
    } else if (viewId === 'stats') {
        renderStats('daily');
        setActiveStatBtn(btnStatDaily);
        renderTimerBarChart();
        renderCalorieSection();
        renderExpenseSection();
    } else if (viewId === 'schedule') {
        renderWeeklySchedule();
    } else if (viewId === 'diary') {
        const today = getTodayString();
        const picker = document.getElementById('diary-date-picker');
        if (picker && !picker.value) picker.value = today;
        renderDiaryView(picker ? picker.value : today);
    } else if (viewId === 'settings') {
        // Auto-fill form
        const inputClientId = document.getElementById('setting-client-id');
        const inputApiKey = document.getElementById('setting-api-key');
        if (state.settings && inputClientId && inputApiKey) {
            inputClientId.value = state.settings.clientId || '';
            inputApiKey.value = state.settings.apiKey || '';
        }
        
        const layoutSelect = document.getElementById('setting-layout-mode');
        if (layoutSelect && state.settings) {
            layoutSelect.value = state.settings.layoutMode || 'auto';
        }
    }
}

// --- Event Listeners ---
function setupEventListeners() {
    // Navigation
    navLinks.forEach(link => {
        link.addEventListener('click', () => switchView(link.dataset.view));
    });

    const diaryDatePicker = document.getElementById('diary-date-picker');
    if (diaryDatePicker) {
        diaryDatePicker.addEventListener('change', () => renderDiaryView(diaryDatePicker.value));
    }

    // Adding Task
    // Set date picker default to today
    if (inputDate) inputDate.value = getTodayString();

    // Hide/show date picker based on routine selection
    if (inputRoutine && inputDate) {
        inputRoutine.addEventListener('change', () => {
            inputDate.closest('.input-group').style.opacity = inputRoutine.value === 'true' ? '0.4' : '1';
            inputDate.disabled = inputRoutine.value === 'true';
        });
    }

    formAdd.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputName.value.trim();
        const duration = parseInt(inputDuration.value) || 0;
        const isRoutine = inputRoutine.value === 'true';
        const tag = inputTag.value;
        const targetDate = (!isRoutine && inputDate && inputDate.value) ? inputDate.value : getTodayString();

        if (text) {
            addTask(text, duration, isRoutine, tag, targetDate);
            inputName.value = '';
            inputDuration.value = '';
            inputRoutine.value = 'false';
            inputTag.value = 'タスク';
            if (inputDate) {
                inputDate.value = getTodayString();
                inputDate.disabled = false;
                inputDate.closest('.input-group').style.opacity = '1';
            }
        }
    });

    // Adding Memo (タスク未満)
    const formMemo = document.getElementById('add-memo-form');
    if (formMemo) {
        formMemo.addEventListener('submit', e => {
            e.preventDefault();
            const input = document.getElementById('memo-text');
            if (!input.value.trim()) return;
            addMemo(input.value);
            input.value = '';
        });
    }

    // Smart Import
    btnImport.addEventListener('click', () => {
        const text = inputGcal.value;
        if (!text.trim()) return;
        const importTypeElem = document.querySelector('input[name="import-type"]:checked');
        const importType = importTypeElem ? importTypeElem.value : 'task';
        smartParse(text, importType);
        inputGcal.value = '';
    });

    // Calendar
    btnPrevMonth.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
        renderHistoryCalendar();
    });
    btnNextMonth.addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
        renderHistoryCalendar();
    });

    // Stats
    if(btnStatDaily) btnStatDaily.addEventListener('click', () => { setActiveStatBtn(btnStatDaily); renderStats('daily'); });
    if(btnStatWeekly) btnStatWeekly.addEventListener('click', () => { setActiveStatBtn(btnStatWeekly); renderStats('weekly'); });
    if(btnStatMonthly) btnStatMonthly.addEventListener('click', () => { setActiveStatBtn(btnStatMonthly); renderStats('monthly'); });

    // Timer chart period buttons
    const btnChart7  = document.getElementById('btn-chart-7d');
    const btnChart30 = document.getElementById('btn-chart-30d');
    function setChartBtn(active) {
        [btnChart7, btnChart30].forEach(b => b && b.classList.remove('active'));
        if (active) active.classList.add('active');
    }
    if (btnChart7)  btnChart7.addEventListener('click',  () => { timerChartDays = 7;  setChartBtn(btnChart7);  renderTimerBarChart(); });
    if (btnChart30) btnChart30.addEventListener('click', () => { timerChartDays = 30; setChartBtn(btnChart30); renderTimerBarChart(); });

    // Calorie handlers
    const btnAddCalorie    = document.getElementById('btn-add-calorie');
    const calorieLabel     = document.getElementById('calorie-label-input');
    const calorieAmount    = document.getElementById('calorie-amount-input');
    const calorieTargetEl  = document.getElementById('calorie-target-input');
    if (btnAddCalorie) btnAddCalorie.addEventListener('click', addCalorieRecord);
    if (calorieAmount) calorieAmount.addEventListener('keydown', e => { if (e.key === 'Enter') addCalorieRecord(); });
    if (calorieLabel)  calorieLabel.addEventListener('keydown',  e => { if (e.key === 'Enter') calorieAmount && calorieAmount.focus(); });
    if (calorieTargetEl) calorieTargetEl.addEventListener('change', () => {
        const v = parseInt(calorieTargetEl.value);
        if (v > 0) { state.settings.calorieTarget = v; saveData(); renderCalorieSection(); }
    });

    // Expense handlers
    const btnAddExpense   = document.getElementById('btn-add-expense');
    const expenseLabelEl  = document.getElementById('expense-label-input');
    const expenseAmountEl = document.getElementById('expense-amount-input');
    const expenseBudgetEl = document.getElementById('expense-budget-input');
    if (btnAddExpense)   btnAddExpense.addEventListener('click', addExpenseRecord);
    if (expenseAmountEl) expenseAmountEl.addEventListener('keydown', e => { if (e.key === 'Enter') addExpenseRecord(); });
    if (expenseLabelEl)  expenseLabelEl.addEventListener('keydown',  e => { if (e.key === 'Enter') expenseAmountEl && expenseAmountEl.focus(); });
    if (expenseBudgetEl) expenseBudgetEl.addEventListener('change', () => {
        const v = parseInt(expenseBudgetEl.value);
        if (v > 0) { state.settings.expenseBudget = v; saveData(); renderExpenseSection(); }
    });

    // Schedule
    if(btnPrevWeek) btnPrevWeek.addEventListener('click', () => {
        const isMobile = document.body.classList.contains('mobile-layout');
        const step = isMobile ? 1 : 7;
        currentWeekStart.setDate(currentWeekStart.getDate() - step);
        renderWeeklySchedule();
    });
    if(btnNextWeek) btnNextWeek.addEventListener('click', () => {
        const isMobile = document.body.classList.contains('mobile-layout');
        const step = isMobile ? 1 : 7;
        currentWeekStart.setDate(currentWeekStart.getDate() + step);
        renderWeeklySchedule();
    });

    const formSchedule = document.getElementById('add-schedule-form');
    if (formSchedule) {
        const dateInput = document.getElementById('schedule-date');
        if (dateInput) dateInput.value = getTodayString();
        formSchedule.addEventListener('submit', (e) => {
            e.preventDefault();
            const date = document.getElementById('schedule-date').value;
            const startStr = document.getElementById('schedule-start').value;
            const endStr = document.getElementById('schedule-end').value;
            const title = document.getElementById('schedule-title').value.trim();
            const tag = document.getElementById('schedule-tag').value;
            const memo = document.getElementById('schedule-memo').value.trim();
            const isRecord = document.getElementById('schedule-is-record') ? document.getElementById('schedule-is-record').checked : false;
            
            const finalTag = isRecord ? 'record' : tag;
            
            if(title && date && startStr && endStr) {
                state.schedules.push({
                    id: generateId(),
                    title: title,
                    date: date,
                    startTime: startStr,
                    endTime: endStr,
                    tag: finalTag,
                    memo: memo
                });
                saveData();
                document.getElementById('schedule-title').value = '';
                document.getElementById('schedule-memo').value = '';
                renderWeeklySchedule();
            }
        });
    }

    const btnSyncGcal = document.getElementById('btn-sync-gcal');
    if (btnSyncGcal) {
        btnSyncGcal.addEventListener('click', async () => {
            if (!gapiInited || !gisInited) {
                // If gapi/google scripts are now available but initGAPI hasn't completed yet,
                // try to initialize on-demand before giving up.
                if ((window.gapi || window.google) && state.settings?.apiKey && state.settings?.clientId) {
                    initGAPI();
                    // Wait up to 5 seconds for initialization to complete
                    for (let i = 0; i < 10; i++) {
                        await new Promise(r => setTimeout(r, 500));
                        if (gapiInited && gisInited) break;
                    }
                }
                if (!gapiInited || !gisInited) {
                    alert("Google APIが初期化されていません。設定画面でキーが正しく入力されているか確認してください。");
                    return;
                }
            }
            authCallback = fetchGoogleCalendarEvents;
            
            // Use prompt: '' instead of 'consent' to skip the consent screen if already authorized.
            // This still shows the account picker if multiple accounts are present.
            isSilentAuthAttempt = false;
            tokenClient.requestAccessToken({ prompt: '' });
        });
    }

    // Settings
    const formSettings = document.getElementById('settings-form');
    if (formSettings) {
        formSettings.addEventListener('submit', (e) => {
            e.preventDefault();
            state.settings.clientId = document.getElementById('setting-client-id').value.trim();
            state.settings.apiKey = document.getElementById('setting-api-key').value.trim();
            saveData();
            initGAPI();
            
            const msg = document.getElementById('settings-save-msg');
            msg.style.opacity = '1';
            setTimeout(() => { msg.style.opacity = '0'; }, 3000);
        });
    }

    // Firebase Settings
    const fbForm = document.getElementById('firebase-settings-form');
    if (fbForm) {
        const inputFb = document.getElementById('setting-firebase-config');
        if (state.settings && state.settings.firebaseConfig) {
            inputFb.value = JSON.stringify(state.settings.firebaseConfig, null, 2);
        }
        fbForm.addEventListener('submit', (e) => {
            e.preventDefault();
            try {
                const configStr = inputFb.value.trim();
                const configObj = new Function("return " + configStr)(); // Handles unquoted keys
                
                state.settings.firebaseConfig = configObj;
                saveData();
                
                const msg = document.getElementById('firebase-save-msg');
                msg.style.opacity = '1';
                setTimeout(() => { msg.style.opacity = '0'; }, 3000);
                
                initFirebase();
            } catch (err) {
                alert("JSONの形式が正しくありません。中括弧 {} で囲まれた有効な設定にしてください。");
            }
        });
    }

    // Firebase Auth Buttons
    const btnLogin = document.getElementById('btn-firebase-login');
    const btnLogout = document.getElementById('btn-firebase-logout');
    if (btnLogin) {
        btnLogin.addEventListener('click', () => {
            if (!auth) {
                alert("Firebaseの設定が行われていません。設定画面からfirebaseConfigを入力してください。");
                return;
            }
            const provider = new firebase.auth.GoogleAuthProvider();
            auth.signInWithPopup(provider).catch(err => {
                alert("ログイン失敗: " + err.message);
            });
        });
    }
    if (btnLogout) {
        btnLogout.addEventListener('click', () => {
            if (auth) auth.signOut();
        });
    }

    // Layout Settings
    const layoutSelect = document.getElementById('setting-layout-mode');
    if (layoutSelect) {
        layoutSelect.addEventListener('change', (e) => {
            if (!state.settings) state.settings = {};
            state.settings.layoutMode = e.target.value;
            saveData();
            applyLayoutMode();
        });
    }

    // Timer Handlers
    if (timerSelect) {
        timerSelect.addEventListener('change', () => {
            const newTaskId = timerSelect.value;
            if (!newTaskId || newTaskId === state.timer.taskId || state.timer.isRunning) return;
            stashCurrentTimer();
            const idx = state.pausedTimers.findIndex(t => t.taskId === newTaskId);
            state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
            state.timer.taskId = newTaskId;
            state.timer.isRunning = false;
            saveData();
            updateTimerDisplay();
            renderPausedTimers();
            if (state.timer.accumulatedSeconds > 0) {
                btnTimerStart.innerHTML = '▶ 再開';
                btnTimerFinish.disabled = false;
                btnTimerCancel.style.display = 'block';
                if (btnTimerReset) btnTimerReset.style.display = 'block';
            } else {
                btnTimerStart.innerHTML = '▶ 開始';
                btnTimerFinish.disabled = true;
                btnTimerCancel.style.display = 'none';
                if (btnTimerReset) btnTimerReset.style.display = 'none';
            }
            btnTimerStart.classList.replace('secondary', 'primary');
        });
    }

    if (btnTimerStart) {
        btnTimerStart.addEventListener('click', () => {
            const taskId = timerSelect.value;
            if (!taskId) return alert("タスクを選択してください");

            if (state.timer.isRunning) {
                // Pause
                const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
                state.timer.accumulatedSeconds += elapsed;
                state.timer.isRunning = false;
                state.timer.startTime = null;
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                saveData();
                syncTimerUI();
            } else {
                // Start/Resume — task switching via change handler, but handle fallback
                if (state.timer.taskId !== taskId) {
                    stashCurrentTimer();
                    const idx = state.pausedTimers.findIndex(t => t.taskId === taskId);
                    state.timer.accumulatedSeconds = idx >= 0 ? state.pausedTimers.splice(idx, 1)[0].accumulatedSeconds : 0;
                    state.timer.taskId = taskId;
                }
                state.timer.isRunning = true;
                state.timer.startTime = Date.now();
                saveData();
                syncTimerUI();
            }
        });
    }
    
    // We can keep btnTimerPause for backward compatibility or just ignore it
    if (btnTimerPause) {
        btnTimerPause.style.display = 'none';
    }
    
    if (btnTimerFinish) {
        btnTimerFinish.addEventListener('click', () => {
            const now = Date.now();
            let totalSeconds = state.timer.accumulatedSeconds;
            if (state.timer.isRunning && state.timer.startTime) {
                totalSeconds += Math.floor((now - state.timer.startTime) / 1000);
            }

            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;

            if (totalSeconds < 60) {
                alert("1分未満のため、実績として記録されません。タイマーはそのまま継続できます。");
                if (state.timer.isRunning) runTimerInterval();
                return;
            }

            // Flash the timer display green before resetting
            timerDisplay.classList.add('timer-flash');

            const task = state.tasks.find(t => t.id === state.timer.taskId);
            if (task) {
                task.completed = true;

                const startTs = state.timer.isRunning ? state.timer.startTime : (now - totalSeconds * 1000);
                const startD = new Date(startTs);
                const endD = new Date(now);

                const startStr = `${startD.getHours().toString().padStart(2, '0')}:${startD.getMinutes().toString().padStart(2, '0')}`;
                const endStr = `${endD.getHours().toString().padStart(2, '0')}:${endD.getMinutes().toString().padStart(2, '0')}`;

                const dateStr = getTodayString();

                state.schedules.push({
                    id: generateId(),
                    title: `⏱ ${task.text}`,
                    date: dateStr,
                    startTime: startStr,
                    endTime: endStr,
                    tag: 'record',
                    taskTag: task.tag || 'タスク',
                    memo: `計測時間: ${formatTimer(totalSeconds)}`
                });

                const historyDateStr = getTodayString();
                if (!state.history[historyDateStr]) state.history[historyDateStr] = { rate: 0, tasksCompleted: 0, tasksTotal: 0, memo: '', durationByTag: {} };
                state.history[historyDateStr].tasksCompleted++;
            } else {
                console.error("[Timer] Task not found for ID:", state.timer.taskId);
            }

            const finishedTaskId = state.timer.taskId;
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            saveData();
            syncTimerUI();
            renderPausedTimers();

            if (document.getElementById('view-schedule').classList.contains('active')) {
                renderWeeklySchedule();
            }

            // Show modal immediately — flash animation (0.65s CSS) plays through the overlay fade-in
            const finishedTask = state.tasks.find(t => t.id === finishedTaskId);
            showTimerCompletionModal(finishedTask ? finishedTask.text : "");
            setTimeout(() => timerDisplay.classList.remove('timer-flash'), 700);
        });
    }

    if (btnTimerCancel) {
        btnTimerCancel.addEventListener('click', () => {
            if (!confirm("タイマーを中止しますか？（記録は残りません）")) return;
            
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;
            
            state.timer = { taskId: null, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            timerDisplay.textContent = '00:00:00';
            timerSelect.disabled = false;
            timerSelect.value = '';
            btnTimerPause.style.display = 'none';
            btnTimerStart.style.display = 'block';
            btnTimerStart.textContent = '▶ 開始';
            btnTimerFinish.disabled = true;
            btnTimerCancel.style.display = 'none';

            saveData();
            renderPausedTimers();
        });
    }

    if (btnTimerReset) {
        btnTimerReset.addEventListener('click', () => {
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;

            const currentTaskId = state.timer.taskId;
            state.timer = { taskId: currentTaskId, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            saveData();
            timerSelect.disabled = false;
            btnTimerFinish.disabled = true;
            btnTimerCancel.style.display = 'none';
            btnTimerReset.style.display = 'none';
            btnTimerStart.innerHTML = '▶ 開始';
            btnTimerStart.classList.replace('secondary', 'primary');
            timerDisplay.textContent = '00:00:00';
            updateTimerSelect();
            if (currentTaskId) timerSelect.value = currentTaskId;
            renderPausedTimers();
        });
    }

    const btnCloseTimerModal = document.getElementById('btn-close-timer-modal');
    if (btnCloseTimerModal) {
        btnCloseTimerModal.addEventListener('click', () => {
            document.getElementById('timer-completion-modal').classList.remove('active');
        });
    }

    const btnNextTask = document.getElementById('btn-next-task');
    if (btnNextTask) {
        btnNextTask.addEventListener('click', () => {
            document.getElementById('timer-completion-modal').classList.remove('active');

            const todayStr = getTodayString();
            const next = state.tasks
                .filter(t => !t.completed && t.date <= todayStr)
                .sort((a, b) => a.text.localeCompare(b.text))[0];

            updateTimerSelect();
            if (next) {
                timerSelect.value = next.id;
            }
        });
    }

}

function applyLayoutMode() {
    const mode = state.settings ? (state.settings.layoutMode || 'auto') : 'auto';
    const body = document.body;
    
    let target = '';
    if (mode === 'mobile') target = 'mobile-layout';
    else if (mode === 'pc') target = 'pc-layout';
    else {
        target = window.innerWidth <= 768 ? 'mobile-layout' : 'pc-layout';
    }
    
    if (!body.classList.contains(target)) {
        body.classList.remove('pc-layout', 'mobile-layout');
        body.classList.add(target);
        return true; // Changed
    }
    return false; // No change
}

function setActiveStatBtn(btn) {
    [btnStatDaily, btnStatWeekly, btnStatMonthly].forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

// --- Core Logic ---
function addTask(text, duration, isRoutine, tag = 'タスク', targetDate = getTodayString()) {
    const task = {
        id: generateId(),
        text,
        duration,
        tag,
        date: targetDate,
        completed: false,
        isRoutine
    };
    state.tasks.push(task);

    if (isRoutine) {
        // Add to routines list if not already there (by exact name)
        const exists = state.routines.find(r => r.text === text);
        if (!exists) {
            state.routines.push({ id: generateId(), text, duration, tag });
        }
    }
    saveData();
}

function toggleTask(id) {
    const task = state.tasks.find(t => t.id === id);
    if (task) {
        task.completed = !task.completed;
        saveData();
    }
}

function deleteTask(id) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    // Note: We don't delete from routines automatically to prevent accidental loss of routine template
    saveData();
}

function addSchedule(title, date, startTime, endTime, tag, memo, gcalId = null) {
    state.schedules.push({
        id: generateId(),
        gcalId,
        title,
        date,
        startTime,
        endTime,
        tag,
        memo
    });
    // saveData will be called by the caller
}

async function fetchGoogleCalendarEvents(silent = false) {
    try {
        // Always sync the whole week containing the selected date
        const start = getMonday(currentWeekStart);
        start.setHours(0,0,0,0);
        const end = new Date(currentWeekStart);
        end.setDate(end.getDate() + 7);
        end.setHours(0,0,0,0);

        const response = await gapi.client.calendar.events.list({
            'calendarId': 'primary',
            'timeMin': start.toISOString(),
            'timeMax': end.toISOString(),
            'showDeleted': false,
            'singleEvents': true,
            'orderBy': 'startTime',
            'timeZone': 'Asia/Tokyo'
        });
        
        const events = response.result.items;
        
        // Save the calendar email as a login hint for future silent syncs
        if (response.result.summary && response.result.summary.includes('@')) {
            if (state.settings.googleEmail !== response.result.summary) {
                state.settings.googleEmail = response.result.summary;
                saveData();
            }
        }

        if (!events || events.length === 0) {
            if (!silent) alert('今週の予定は見つかりませんでした。');
            return;
        }

        let added = 0;
        let updated = 0;
        let taskAdded = 0;
        let taskUpdated = 0;

        events.forEach(event => {
            if (!event.start.dateTime) return; // skip all-day events

            const rawStart = event.start.dateTime;
            const rawEnd   = event.end.dateTime;

            const dateStr  = rawStart.substring(0, 10);
            const startStr = rawStart.substring(11, 16);
            const endStr   = rawEnd.substring(11, 16);

            console.log('[GCal Debug] raw:', rawStart, '\u2192 saved as', dateStr, startStr, '-', endStr);

            const gcalId = event.id;
            const title = event.summary || '予定';
            const memo = event.description || '';

            // --- Schedule registration ---
            const existingIdx = state.schedules.findIndex(s => s.gcalId === gcalId);
            if (existingIdx !== -1) {
                state.schedules[existingIdx].title = title;
                state.schedules[existingIdx].date = dateStr;
                state.schedules[existingIdx].startTime = startStr;
                state.schedules[existingIdx].endTime = endStr;
                state.schedules[existingIdx].memo = memo;
                updated++;
            } else {
                addSchedule(title, dateStr, startStr, endStr, 'カレンダー', memo, gcalId);
                added++;
            }

            // --- Task registration for manaba events (enables timer use) ---
            if (title.toLowerCase().includes('manaba')) {
                const [sh, sm] = startStr.split(':').map(Number);
                const [eh, em] = endStr.split(':').map(Number);
                const durationMin = (eh * 60 + em) - (sh * 60 + sm);

                const existingTask = state.tasks.find(t => t.gcalId === gcalId);
                if (existingTask) {
                    existingTask.text = title;
                    existingTask.date = dateStr;
                    existingTask.duration = durationMin;
                    taskUpdated++;
                } else {
                    state.tasks.push({
                        id: generateId(),
                        gcalId,
                        text: title,
                        duration: durationMin,
                        tag: '勉強・課題',
                        date: dateStr,
                        completed: false,
                        isRoutine: false
                    });
                    taskAdded++;
                }
            }
        });

        saveData();
        if (document.getElementById('view-schedule').classList.contains('active')) {
            renderWeeklySchedule();
        }

        // Update last-sync time display
        const now = new Date();
        const timeStr = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
        const gcalSyncEl = document.getElementById('gcal-last-sync');
        if (gcalSyncEl) gcalSyncEl.textContent = `GCal 最終同期: ${timeStr}`;

        console.log(`[GCal] done. added=${added}, updated=${updated}, taskAdded=${taskAdded}`);
        if (!silent) {
            const taskMsg = taskAdded > 0 ? `\nタスク自動登録(manaba): ${taskAdded}件` : '';
            alert(`Googleカレンダーと自動同期しました！\n（新規: ${added}件, 更新: ${updated}件）${taskMsg}`);
        }
        
    } catch (err) {
        console.error(err);
        if (!silent) {
            alert('同期に失敗しました: ' + (err.message || '不明なエラー'));
        } else {
            console.log('[Auto-sync] failed silently:', err.message);
        }
    }
}

// --- Auto Sync ---
// Attempts a silent token refresh and syncs Google Calendar in the background.
// Works when the user has previously granted consent and the session is still alive.
function autoSyncGoogleCalendar() {
    if (!gapiInited || !gisInited) return;
    if (gapi.client.getToken() === null) return;
    fetchGoogleCalendarEvents(true);
}

// --- Memo (タスク未満) ---
function renderMemos() {
    const memoList = document.getElementById('memo-list');
    const memoCount = document.getElementById('memo-count');
    if (!memoList) return;

    memoList.innerHTML = '';
    const memos = state.memos || [];
    if (memoCount) memoCount.textContent = memos.length;

    if (memos.length === 0) {
        memoList.innerHTML = '<li style="color:var(--text-secondary);font-size:0.85rem;padding:0.5rem 0;text-align:center;">まだ登録がありません</li>';
        return;
    }

    const svgTrash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

    memos.forEach(memo => {
        const li = document.createElement('li');
        li.className = `memo-item${memo.done ? ' done' : ''}`;
        li.innerHTML = `
            <div class="memo-dot" onclick="toggleMemo('${memo.id}')"></div>
            <span class="memo-text" onclick="toggleMemo('${memo.id}')">${memo.text}</span>
            <span style="font-size:0.72rem;color:var(--text-secondary);margin-right:4px;white-space:nowrap;flex-shrink:0;">${memo.createdAt ? memo.createdAt.substring(5).replace('-', '/') : ''}</span>
            <button class="btn-delete" onclick="deleteMemo('${memo.id}')">${svgTrash}</button>
        `;
        memoList.appendChild(li);
    });
}

function addMemo(text) {
    if (!state.memos) state.memos = [];
    state.memos.unshift({ id: generateId(), text: text.trim(), createdAt: getTodayString(), done: false });
    saveData();
}

function deleteMemo(id) {
    state.memos = (state.memos || []).filter(m => m.id !== id);
    saveData();
}

function toggleMemo(id) {
    const memo = (state.memos || []).find(m => m.id === id);
    if (memo) { memo.done = !memo.done; saveData(); }
}

// --- Smart Text Parser ---
function smartParse(rawText, importType = 'task') {
    // Looks for patterns like "10:00～11:00 Event Name" or "10:00 - 11:30 Meeting"
    const lines = rawText.split('\n');
    const timeRegex = /(\d{1,2}:\d{2})\s*(?:～|-|~|to)\s*(\d{1,2}:\d{2})\s*(.*)/i;
    let added = 0;

    lines.forEach(line => {
        const match = line.match(timeRegex);
        if (match) {
            const startStr = match[1];
            const endStr = match[2];
            let name = match[3].trim();
            
            if (!name) name = "Imported Event";

            // Calculate duration
            const [sh, sm] = startStr.split(':').map(Number);
            const [eh, em] = endStr.split(':').map(Number);
            
            let startMins = sh * 60 + sm;
            let endMins = eh * 60 + em;
            if (endMins < startMins) endMins += 24 * 60; // crossed midnight
            
            if (importType === 'schedule') {
                const pad = n => String(n).padStart(2, '0');
                state.schedules.push({
                    id: generateId(),
                    title: name,
                    date: getTodayString(),
                    startTime: `${pad(sh)}:${pad(sm)}`,
                    endTime: `${pad(eh)}:${pad(em)}`,
                    tag: 'カレンダー',
                    memo: ''
                });
            } else {
                const duration = endMins - startMins;
                addTask(name, duration, false, 'カレンダー', getTodayString());
            }
            added++;
        } else if (line.trim().length > 0 && !line.includes('http')) {
            // Fallback for lines without time, maybe it's just a task list
            // Avoid parsing pure URLs
            if (importType === 'schedule') {
                // Ignore schedule imports without time
            } else {
                addTask(line.trim(), 0, false, 'カレンダー', getTodayString());
                added++;
            }
        }
    });

    if (added === 0) {
        alert("テキストからタスクを解析できませんでした。");
    }
}

// --- Rendering Dashboard ---
function renderDashboard() {
    updateTimerSelect();
    listActive.innerHTML = '';
    listCompleted.innerHTML = '';

    let active = 0;
    let completed = 0;

    const todayStr = getTodayString();
    state.tasks.forEach(task => {
        const isToday = task.date === todayStr;
        const isOverdue = task.date < todayStr && !task.completed;
        
        if (!isToday && !isOverdue) return;
        
        const displayName = (task.date < todayStr) ? `${task.text} (${task.date.substring(5)})` : task.text;
        const li = document.createElement('li');
        li.className = 'task-item';
        
        // Duration string
        const durStr = task.duration ? `<span>🕒 ${task.duration}分</span>` : '';
        const routineStr = task.isRoutine ? `<span class="tag-routine">毎日</span>` : '';

        const tagClassMap = {
            '講義': 'tag-lecture',
            '勉強・課題': 'tag-study',
            '趣味・遊び': 'tag-hobby',
            'タスク': 'tag-task',
            'カレンダー': 'tag-calendar'
        };
        const tagClass = tagClassMap[task.tag] || 'tag-task';
        const tagBadge = `<span class="tag-badge ${tagClass}">${task.tag || 'タスク'}</span>`;

        li.innerHTML = `
            <div class="task-checkbox ${task.completed ? 'checked' : ''}" onclick="toggleTask('${task.id}')"></div>
            <div class="task-content">
                <div class="task-name">${displayName}</div>
                <div class="task-meta">
                    ${tagBadge}
                    ${durStr}
                    ${routineStr}
                </div>
            </div>
            <button class="btn-delete" onclick="deleteTask('${task.id}')">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;

        if (task.completed) {
            listCompleted.appendChild(li);
            completed++;
        } else {
            listActive.appendChild(li);
            active++;
        }
    });

    countActive.textContent = active;
    countCompleted.textContent = completed;

    updateProgressRing(completed, active + completed);
    renderMemos();
}

function updateProgressRing(completed, total) {
    const radius = 26;
    const circumference = radius * 2 * Math.PI;
    
    progressRing.style.strokeDasharray = `${circumference} ${circumference}`;
    
    let percent = total === 0 ? 0 : Math.round((completed / total) * 100);
    const offset = circumference - (percent / 100) * circumference;
    
    progressRing.style.strokeDashoffset = offset;
    progressPercent.textContent = `${percent}%`;

    if (total === 0) {
        progressText.textContent = "タスクを追加して計画を立てましょう。";
    } else if (percent === 100) {
        progressText.textContent = "すべて完了しました！お疲れ様でした。";
        progressRing.style.stroke = "var(--success-color)";
    } else {
        progressText.textContent = "その調子！頑張りましょう。";
        progressRing.style.stroke = "var(--primary-color)";
    }
}

// --- History Calendar ---
function renderHistoryCalendar() {
    calendarDays.innerHTML = '';
    
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();
    
    calendarMonthYear.textContent = currentCalendarDate.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long' });
    
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    
    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
        const empty = document.createElement('div');
        empty.className = 'day-cell empty';
        calendarDays.appendChild(empty);
    }
    
    // Day cells
    const todayStr = getTodayString();

    for (let i = 1; i <= daysInMonth; i++) {
        const cellDate = new Date(year, month, i);
        const dateStr = cellDate.toLocaleDateString('en-CA'); // YYYY-MM-DD format for lookup
        
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        cell.textContent = i;
        
        if (state.history[dateStr]) {
            cell.classList.add('has-data');
        }

        if (dateStr === todayStr) {
            cell.style.border = '1px solid var(--primary-color)';
        }

        cell.addEventListener('click', () => {
            // Remove selection
            document.querySelectorAll('.day-cell').forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');
            showHistoryDetail(dateStr);
        });

        calendarDays.appendChild(cell);
    }
}

function showHistoryDetail(dateStr) {
    const data = state.history[dateStr];
    const dayTasks = state.tasks.filter(t => t.date === dateStr);
    const daySchedules = state.schedules
        .filter(s => s.date === dateStr)
        .sort((a, b) => {
            // Sort by start time, treating <05:00 as next-day (same as schedule view)
            const toMins = t => {
                const [h, m] = t.split(':').map(Number);
                return (h < 5 ? h + 24 : h) * 60 + m;
            };
            return toMins(a.startTime) - toMins(b.startTime);
        });

    if (!data && daySchedules.length === 0 && dayTasks.length === 0) {
        historyDetailContent.innerHTML = `<p class="empty-state">この日のデータはありません。</p>`;
        return;
    }

    const tagBorderMap = {
        '講義':     '#3b82f6',
        '勉強・課題': '#10b981',
        '趣味・遊び': '#f59e0b',
        'タスク':    '#8b5cf6',
        'カレンダー': '#ef4444',
        'record':   '#f43f5e'
    };
    const tagBgMap = {
        '講義':     'rgba(59, 130, 246, 0.12)',
        '勉強・課題': 'rgba(16, 185, 129, 0.12)',
        '趣味・遊び': 'rgba(245, 158, 11, 0.12)',
        'タスク':    'rgba(139, 92, 246, 0.12)',
        'カレンダー': 'rgba(239, 68, 68, 0.12)',
        'record':   'rgba(244, 63, 94, 0.18)'
    };

    let html = `<h4 style="font-size: 1rem; color: var(--text-secondary); margin-bottom: 1rem;">${dateStr}</h4>`;

    // --- Reflection summary ---
    if (data) {
        let rateColor = 'var(--text-primary)';
        if (data.rate >= 80) rateColor = 'var(--success-color)';
        else if (data.rate <= 30) rateColor = 'var(--danger-color)';

        html += `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                <span style="color:var(--text-secondary); font-size:0.9rem;">${data.tasksCompleted} / ${data.tasksTotal} タスク完了</span>
                <span style="font-size:1.4rem; font-weight:bold; color:${rateColor}">${data.rate}%</span>
            </div>`;

        if (data.memo) {
            html += `<div class="history-memo" style="margin-bottom:1.25rem;">${data.memo.replace(/\n/g, '<br>')}</div>`;
        }
    }

    // --- Task list ---
    if (dayTasks.length > 0) {
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.5rem; margin-top:${data ? '0.25rem' : '0'};">タスク</div>`;
        dayTasks.forEach(task => {
            const done = task.completed;
            const color = tagBorderMap[task.tag] || tagBorderMap['タスク'];
            html += `
                <div style="display:flex; align-items:center; gap:0.6rem; padding:0.35rem 0; border-bottom:1px solid var(--panel-border); font-size:0.9rem;">
                    <span style="width:8px; height:8px; border-radius:50%; background:${color}; flex-shrink:0;"></span>
                    <span style="${done ? 'text-decoration:line-through; color:var(--text-secondary);' : ''}">${task.text}</span>
                    ${task.duration ? `<span style="margin-left:auto; color:var(--text-secondary); font-size:0.8rem; white-space:nowrap;">${task.duration}分</span>` : ''}
                </div>`;
        });
        html += `<div style="margin-bottom:1.25rem;"></div>`;
    }

    // --- Schedule timeline ---
    if (daySchedules.length > 0) {
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.6rem;">スケジュール</div>`;
        daySchedules.forEach(sched => {
            const border = tagBorderMap[sched.tag] || tagBorderMap['タスク'];
            const bg    = tagBgMap[sched.tag]    || tagBgMap['タスク'];
            html += `
                <div style="display:flex; gap:0.6rem; align-items:stretch; margin-bottom:0.45rem;">
                    <div style="width:3px; background:${border}; border-radius:2px; flex-shrink:0;"></div>
                    <div style="flex:1; background:${bg}; border-radius:6px; padding:0.45rem 0.7rem;">
                        <div style="font-size:0.9rem; font-weight:500;">${sched.title}</div>
                        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.1rem;">${sched.startTime} – ${sched.endTime}</div>
                        ${sched.memo ? `<div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.15rem;">${sched.memo}</div>` : ''}
                    </div>
                </div>`;
        });
    }

    // --- Expense summary ---
    const dayExpenses = (state.expenses && state.expenses[dateStr]) || [];
    if (dayExpenses.length > 0) {
        const expTotal = dayExpenses.reduce((s, r) => s + r.amount, 0);
        html += `<div style="font-weight:600; font-size:0.85rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:0.5rem; margin-top:1.25rem;">支出</div>`;
        html += `<div style="font-size:1.2rem; font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">¥${expTotal.toLocaleString()}</div>`;
        dayExpenses.forEach(r => {
            html += `
                <div style="display:flex; justify-content:space-between; padding:0.3rem 0; border-bottom:1px solid var(--panel-border); font-size:0.88rem;">
                    <span style="color:var(--text-primary);">${r.label}</span>
                    <span style="color:var(--text-secondary);">¥${r.amount.toLocaleString()}</span>
                </div>`;
        });
    }

    historyDetailContent.innerHTML = html;
}

// --- Stats Logic ---
function renderStats(period) {
    if (!statsContent) return;

    const today = new Date();
    const dates = [];

    if (period === 'daily') {
        dates.push(getTodayString());
    } else if (period === 'weekly') {
        // Last 7 days including today
        for (let i = 0; i < 7; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            dates.push(d.toLocaleDateString('en-CA'));
        }
    } else if (period === 'monthly') {
        // This month
        const year = today.getFullYear();
        const month = today.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        for (let i = 1; i <= daysInMonth; i++) {
            const d = new Date(year, month, i);
            dates.push(d.toLocaleDateString('en-CA'));
        }
    }

    const tagCounts = {};
    let totalMins = 0;
    const dateSet = new Set(dates);
    let plannedTotal = 0;
    let recordedTotal = 0;

    // Single pass: build tag breakdown AND achievement totals at once
    state.schedules.forEach(s => {
        if (!s.startTime || !s.endTime) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let startMin = sh * 60 + sm;
        let endMin = eh * 60 + em;
        if (endMin < startMin) endMin += 24 * 60;
        const mins = endMin - startMin;
        if (mins <= 0) return;

        if (s.tag === 'record') {
            recordedTotal += mins / 60;
            if (dateSet.has(s.date)) {
                let tag = s.taskTag;
                if (!tag) {
                    const taskName = s.title.replace(/^⏱\s*/, '');
                    const matched = state.tasks.find(t => t.text === taskName);
                    tag = (matched && matched.tag) ? matched.tag : 'タスク';
                }
                tagCounts[tag] = (tagCounts[tag] || 0) + mins;
                totalMins += mins;
            }
        } else if (s.tag !== 'カレンダー' && s.tag !== 'calendar') {
            plannedTotal += mins / 60;
        }
    });
    
    let achievePct = 0;
    if (plannedTotal > 0) {
        achievePct = Math.min(100, Math.round((recordedTotal / plannedTotal) * 100));
    }
    
    const ring = document.getElementById('stats-achievement-ring');
    const percentText = document.getElementById('stats-achievement-percent');
    const elPlanned = document.getElementById('stats-planned-hours');
    const elRecorded = document.getElementById('stats-recorded-hours');
    
    if (ring && percentText) {
        const circumference = 54 * 2 * Math.PI;
        const offset = circumference - (achievePct / 100) * circumference;
        ring.style.strokeDashoffset = offset;
        percentText.textContent = achievePct + '%';
        elPlanned.textContent = plannedTotal.toFixed(1) + ' 時間';
        elRecorded.textContent = recordedTotal.toFixed(1) + ' 時間';
    }

    const sortedTags = Object.keys(tagCounts).filter(t => tagCounts[t] > 0).sort((a, b) => tagCounts[b] - tagCounts[a]);

    if (sortedTags.length === 0) {
        statsContent.innerHTML = '<p class="empty-state">完了したタスクのデータがありません。</p>';
        return;
    }

    const tagColorMap = {
        '講義': 'var(--tag-lecture)',
        '勉強・課題': 'var(--tag-study)',
        '趣味・遊び': 'var(--tag-hobby)',
        'タスク': 'var(--tag-task)',
        'カレンダー': 'var(--tag-calendar)'
    };

    // Build HTML in one pass, set innerHTML once
    statsContent.innerHTML = sortedTags.map(tag => {
        const mins = tagCounts[tag];
        const hours = Math.floor(mins / 60);
        const m = mins % 60;
        const timeStr = hours > 0 ? `${hours}時間 ${m}分` : `${m}分`;
        const percent = Math.round((mins / totalMins) * 100);
        const color = tagColorMap[tag] || 'var(--tag-task)';
        return `<div class="stat-item">
            <div class="stat-header"><span>${tag}</span><span>${timeStr} (${percent}%)</span></div>
            <div class="stat-bar-bg"><div class="stat-bar-fill" style="width:${percent}%;background:${color}"></div></div>
        </div>`;
    }).join('');
}

// --- Timer Bar Chart ---
let timerChartDays = 7;


function renderTimerBarChart() {
    const container = document.getElementById('timer-bar-chart');
    if (!container) return;

    // Pre-group record schedules by date in one pass instead of O(n×days) repeated scans
    const recordMinsByDate = {};
    state.schedules.forEach(s => {
        if (s.tag !== 'record' || !s.startTime || !s.endTime) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins < 0) mins += 1440;
        recordMinsByDate[s.date] = (recordMinsByDate[s.date] || 0) + Math.max(0, mins);
    });

    const data = [];
    const today = new Date();
    for (let i = timerChartDays - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const minutes = recordMinsByDate[dateStr] || 0;
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ minutes, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxMins = Math.max(...data.map(d => d.minutes), 30);
    const maxH    = Math.ceil(maxMins / 60);
    const yMax    = maxH * 60;
    const totalMins = data.reduce((s, d) => s + d.minutes, 0);
    const tH = Math.floor(totalMins / 60), tM = totalMins % 60;
    const totalStr = tH > 0 ? `${tH}時間${tM > 0 ? tM + '分' : ''}` : `${tM}分`;
    let streak = 0;
    for (let i = data.length - 1; i >= 0; i--) { if (data[i].minutes > 0) streak++; else break; }

    const CHART_H = 150;
    const Y_W = 34;
    const yStepH = maxH <= 2 ? 1 : maxH <= 6 ? 2 : Math.ceil(maxH / 4);
    const yTicks = [];
    for (let h = 0; h <= maxH; h += yStepH) yTicks.push(h);
    if (yTicks[yTicks.length - 1] !== maxH) yTicks.push(maxH);

    // Y-axis labels (from bottom)
    const yLabelsHtml = yTicks.map(h => {
        const px = Math.round((h / maxH) * CHART_H);
        return `<div style="position:absolute;right:4px;bottom:${px}px;font-size:0.62rem;color:var(--text-secondary);transform:translateY(50%);white-space:nowrap">${h}h</div>`;
    }).join('');

    // Grid lines inside bars area (position:absolute)
    const gridHtml = yTicks.map(h => {
        const px = Math.round((h / maxH) * CHART_H);
        return `<div style="position:absolute;left:0;right:0;bottom:${px}px;height:1px;background:rgba(255,255,255,0.06);pointer-events:none"></div>`;
    }).join('');

    const showDow = timerChartDays <= 14;
    // Bar columns and x-labels rendered separately
    const barColsHtml = data.map(d => {
        const barPx = d.minutes > 0 ? Math.max(3, Math.round((d.minutes / yMax) * CHART_H)) : 0;
        const h = Math.floor(d.minutes / 60), m = d.minutes % 60;
        const tip = d.minutes > 0 ? (h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`) : '';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            ${tip ? `<div class="c-tip">${tip}</div>` : ''}
            <div class="c-bar" style="height:${barPx}px"></div>
        </div>`;
    }).join('');

    const xLabelsHtml = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.day}${showDow ? `<br><span style="opacity:.6;font-size:0.58rem">${d.dow}</span>` : ''}</div>`
    ).join('');

    container.innerHTML = `
        <div class="chart-meta-row">
            <span class="chart-total-val">${totalStr}</span>
            ${streak >= 2 ? `<span class="chart-streak-badge">🔥 ${streak}日連続</span>` : ''}
        </div>
        <div style="display:flex;align-items:flex-end;gap:0">
            <div style="width:${Y_W}px;height:${CHART_H}px;position:relative;flex-shrink:0">${yLabelsHtml}</div>
            <div style="flex:1;overflow-x:auto">
                <div style="display:flex;flex-direction:column;min-width:100%">
                    <div class="c-bars-area" style="height:${CHART_H}px;position:relative">${gridHtml}${barColsHtml}</div>
                    <div class="c-xlabels-row">${xLabelsHtml}</div>
                </div>
            </div>
        </div>`;
}

// --- Calorie Tracking ---
function renderCalorieSection() {
    const today = getTodayString();
    if (!state.calories[today]) state.calories[today] = [];
    const records = state.calories[today];
    const total   = records.reduce((s, r) => s + r.kcal, 0);
    const target  = state.settings.calorieTarget || 2000;
    const pct     = Math.min(110, Math.round((total / target) * 100));
    const remain  = target - total;
    const fillColor = pct > 105 ? 'var(--danger-color)' : pct > 85 ? '#f59e0b' : '#10b981';

    const targetEl = document.getElementById('calorie-target-input');
    if (targetEl && !targetEl.matches(':focus')) targetEl.value = target;

    const sumEl = document.getElementById('calorie-today-summary');
    if (sumEl) {
        sumEl.innerHTML = `
            <div class="cal-summary">
                <div class="cal-numbers">
                    <span class="cal-consumed">${total}</span>
                    <span class="cal-sep"> / ${target} kcal</span>
                </div>
                <div class="cal-bar-bg"><div class="cal-bar-fill" style="width:${Math.min(100,pct)}%; background:${fillColor}"></div></div>
                <div class="cal-remain">${remain >= 0 ? `あと ${remain} kcal` : `超過 ${-remain} kcal`}</div>
            </div>`;
    }

    const listEl = document.getElementById('calorie-records-list');
    if (listEl) {
        listEl.innerHTML = records.length === 0
            ? '<p class="empty-state" style="font-size:0.85rem; padding:0.5rem 0;">まだ記録がありません</p>'
            : records.map(r => `
                <div class="cal-record">
                    <span class="cal-record-name">${r.label}</span>
                    <span class="cal-record-kcal">${r.kcal} kcal</span>
                    <button class="cal-del-btn" onclick="deleteCalorieRecord('${today}','${r.id}')">✕</button>
                </div>`).join('');
    }

    renderCalorieChart();
}

function renderCalorieChart() {
    const container = document.getElementById('calorie-chart');
    if (!container) return;
    const target = state.settings.calorieTarget || 2000;

    const data = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const recs = state.calories[dateStr] || [];
        const kcal = recs.reduce((s, r) => s + r.kcal, 0);
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ kcal, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxKcal = Math.max(...data.map(d => d.kcal), target * 1.1);
    const CHART_H = 120;
    const targetPx = Math.round((target / maxKcal) * CHART_H);

    const barColsHtml = data.map(d => {
        const barPx = d.kcal > 0 ? Math.max(3, Math.round((d.kcal / maxKcal) * CHART_H)) : 0;
        const color = d.kcal > target ? 'var(--danger-color)' : '#10b981';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            ${d.kcal > 0 ? `<div class="c-tip">${d.kcal}</div>` : ''}
            <div class="c-bar" style="height:${barPx}px;background:${color};background-image:none"></div>
        </div>`;
    }).join('');

    const xLabelsHtml = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.day}<br><span style="opacity:.6;font-size:0.58rem">${d.dow}</span></div>`
    ).join('');

    // Target line and grid lines inside bars area
    const targetLine = `<div style="position:absolute;left:0;right:0;bottom:${targetPx}px;border-top:1.5px dashed rgba(245,158,11,0.7);pointer-events:none">
        <span style="position:absolute;right:2px;top:-12px;font-size:0.58rem;color:#f59e0b;white-space:nowrap">目標 ${target}</span>
    </div>`;

    container.innerHTML = `
        <div style="display:flex;flex-direction:column">
            <div class="c-bars-area" style="height:${CHART_H}px;position:relative">${targetLine}${barColsHtml}</div>
            <div class="c-xlabels-row">${xLabelsHtml}</div>
        </div>`;
}

function addCalorieRecord() {
    const labelEl  = document.getElementById('calorie-label-input');
    const amountEl = document.getElementById('calorie-amount-input');
    if (!labelEl || !amountEl) return;
    const label = labelEl.value.trim() || '食事';
    const kcal  = parseInt(amountEl.value);
    if (!kcal || kcal <= 0) { amountEl.focus(); return; }
    const today = getTodayString();
    if (!state.calories[today]) state.calories[today] = [];
    state.calories[today].push({ id: generateId(), label, kcal });
    labelEl.value = '';
    amountEl.value = '';
    labelEl.focus();
    saveData();
    renderCalorieSection();
}

function deleteCalorieRecord(dateStr, id) {
    if (!state.calories[dateStr]) return;
    state.calories[dateStr] = state.calories[dateStr].filter(r => r.id !== id);
    saveData();
    renderCalorieSection();
}

// --- Expense Tracking ---
function renderExpenseSection() {
    const today = getTodayString();
    if (!state.expenses) state.expenses = {};
    if (!state.expenses[today]) state.expenses[today] = [];
    const records = state.expenses[today];
    const total   = records.reduce((s, r) => s + r.amount, 0);
    const budget  = state.settings.expenseBudget || 3000;
    const pct     = Math.min(110, Math.round((total / budget) * 100));
    const remain  = budget - total;
    const fillColor = pct > 105 ? 'var(--danger-color)' : pct > 85 ? '#f59e0b' : '#10b981';

    const budgetEl = document.getElementById('expense-budget-input');
    if (budgetEl && !budgetEl.matches(':focus')) budgetEl.value = budget;

    const sumEl = document.getElementById('expense-today-summary');
    if (sumEl) {
        sumEl.innerHTML = `
            <div class="cal-summary">
                <div class="cal-numbers">
                    <span class="cal-consumed">¥${total.toLocaleString()}</span>
                    <span class="cal-sep"> / ¥${budget.toLocaleString()}</span>
                </div>
                <div class="cal-bar-bg"><div class="cal-bar-fill" style="width:${pct}%; background:${fillColor};"></div></div>
                <p class="cal-remain">${remain >= 0 ? `残り ¥${remain.toLocaleString()}` : `¥${Math.abs(remain).toLocaleString()} オーバー`}</p>
            </div>`;
    }

    const listEl = document.getElementById('expense-records-list');
    if (listEl) {
        listEl.innerHTML = records.length === 0
            ? '<p class="empty-state" style="font-size:0.85rem; padding:0.5rem 0;">まだ記録がありません</p>'
            : records.map(r => `
                <div class="cal-record">
                    <span class="cal-record-name">${r.label}</span>
                    <span class="cal-record-kcal">¥${r.amount.toLocaleString()}</span>
                    <button class="cal-del-btn" onclick="deleteExpenseRecord('${today}','${r.id}')">✕</button>
                </div>`).join('');
    }

    renderExpenseChart();
}

function renderExpenseChart() {
    const container = document.getElementById('expense-chart');
    if (!container) return;
    const budget = state.settings.expenseBudget || 3000;

    const data = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleDateString('en-CA');
        const recs = (state.expenses && state.expenses[dateStr]) || [];
        const amount = recs.reduce((s, r) => s + r.amount, 0);
        const dow = ['日','月','火','水','木','金','土'][d.getDay()];
        data.push({ amount, day: String(d.getDate()), dow, isToday: i === 0 });
    }

    const maxVal = Math.max(...data.map(d => d.amount), budget, 1);

    const barsHtml = data.map(d => {
        const barH = Math.round((d.amount / maxVal) * 80);
        const barColor = d.amount > budget ? 'var(--danger-color)' : d.amount > budget * 0.85 ? '#f59e0b' : 'linear-gradient(to top, #6366f1, #818cf8)';
        return `<div class="cbc${d.isToday ? ' cbc-today' : ''}">
            <span class="c-tip">¥${d.amount.toLocaleString()}</span>
            <div class="c-bar" style="height:${barH}px; background:${barColor};"></div>
        </div>`;
    }).join('');

    const xlabels = data.map(d =>
        `<div class="cxl${d.isToday ? ' cxl-today' : ''}">${d.dow}<br>${d.day}</div>`
    ).join('');

    container.innerHTML = `
        <div style="height:80px;" class="c-bars-area">${barsHtml}</div>
        <div class="c-xlabels-row">${xlabels}</div>`;
}

function addExpenseRecord() {
    const labelEl  = document.getElementById('expense-label-input');
    const amountEl = document.getElementById('expense-amount-input');
    if (!labelEl || !amountEl) return;
    const label  = labelEl.value.trim() || '支出';
    const amount = parseInt(amountEl.value);
    if (!amount || amount <= 0) { amountEl.focus(); return; }
    const today = getTodayString();
    if (!state.expenses) state.expenses = {};
    if (!state.expenses[today]) state.expenses[today] = [];
    state.expenses[today].push({ id: generateId(), label, amount });
    labelEl.value = '';
    amountEl.value = '';
    labelEl.focus();
    saveData();
    renderExpenseSection();
}

function deleteExpenseRecord(dateStr, id) {
    if (!state.expenses || !state.expenses[dateStr]) return;
    state.expenses[dateStr] = state.expenses[dateStr].filter(r => r.id !== id);
    saveData();
    renderExpenseSection();
}

// --- Weekly Schedule Logic ---
function renderWeeklySchedule() {
    const grid = document.getElementById('weekly-grid');
    if (!grid) return;

    grid.innerHTML = '';
    
    const isMobile = document.body.classList.contains('mobile-layout');
    
    if (isMobile) {
        document.getElementById('schedule-week-display').textContent = 
            currentWeekStart.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    } else {
        const weekStart = getMonday(currentWeekStart);
        const endOfWeek = new Date(weekStart);
        endOfWeek.setDate(endOfWeek.getDate() + 6);
        document.getElementById('schedule-week-display').textContent = 
            `${weekStart.getFullYear()}年 ${weekStart.getMonth()+1}月${weekStart.getDate()}日 〜 ${endOfWeek.getMonth()+1}月${endOfWeek.getDate()}日`;
    }

    // Fixed height constants for alignment (JS controls height, not CSS)
    const HEADER_H = 60;  // header area height in px
    const TASKS_H  = 120; // tasks area height in px

    // Time column with labels inside its own timeline
    const timeCol = document.createElement('div');
    timeCol.className = 'weekly-time-column';
    // Header and tasks-area spacer use same height constants as data columns
    let timeColHTML = `<div class="weekly-header" style="height:${HEADER_H}px; box-sizing:border-box; border-bottom:none;"></div>`;
    timeColHTML   += `<div style="height:${TASKS_H}px; box-sizing:border-box; border-bottom:1px solid var(--panel-border);"></div>`;
    timeColHTML   += `<div class="weekly-timeline" style="background:transparent; border-right:1px solid var(--panel-border);">` ;
    for (let h = 5; h <= 28; h++) {
        const displayH = h % 24;
        timeColHTML += `<div class="time-slot-label" style="top:${(h-5)*60}px">${displayH}:00</div>`;
    }
    timeColHTML += '</div>';
    timeCol.innerHTML = timeColHTML;
    grid.appendChild(timeCol);

    const todayStr = getTodayString();
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    
    const baseDate = isMobile ? currentWeekStart : getMonday(currentWeekStart);
    const numDays = isMobile ? 1 : 7;
    
    for (let i = 0; i < numDays; i++) {
        const currentDate = new Date(baseDate);
        currentDate.setDate(currentDate.getDate() + i);
        const dateStr = currentDate.toLocaleDateString('en-CA');
        const isToday = dateStr === todayStr;
        const dayLabel = days[currentDate.getDay()];

        const col = document.createElement('div');
        col.className = 'weekly-column';
        
        // Header
        const header = document.createElement('div');
        header.className = `weekly-header ${isToday ? 'today' : ''}`;
        header.innerHTML = `<div class="weekly-day">${dayLabel}</div><div class="weekly-date">${currentDate.getDate()}</div>`;
        col.appendChild(header);

        // Tasks container — height is set via JS to match time-col-spacer exactly
        const tasksDiv = document.createElement('div');
        tasksDiv.className = 'weekly-tasks';
        tasksDiv.style.height = TASKS_H + 'px';
        tasksDiv.style.overflowY = 'auto';
        tasksDiv.style.boxSizing = 'border-box';
        
        const dayTasks = state.tasks.filter(t => t.date === dateStr);
        dayTasks.forEach(task => {
            // Find matching timer record for this task on this date
            const record = task.completed
                ? state.schedules.find(s => s.date === dateStr && s.tag === 'record' && s.title === `⏱ ${task.text}`)
                : null;

            const tDiv = document.createElement('div');
            tDiv.className = `weekly-task-item ${task.completed ? 'completed' : ''}`;
            if (record) tDiv.style.alignItems = 'flex-start';

            tDiv.innerHTML = `
                <input type="checkbox" ${task.completed ? 'checked' : ''} style="flex-shrink:0;${record ? ' margin-top:2px;' : ''}"
                    onchange="toggleTask('${task.id}'); if(document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();">
                <div style="flex:1; min-width:0;">
                    <div class="weekly-task-text" title="${task.text}">${task.text}</div>
                    ${record ? `<div class="task-record-time">⏱ ${record.startTime}–${record.endTime}</div>` : ''}
                </div>
            `;
            tasksDiv.appendChild(tDiv);
        });

        // Header height also controlled by JS for precise alignment
        header.style.height = HEADER_H + 'px';
        header.style.boxSizing = 'border-box';

        col.appendChild(tasksDiv);

        // Timeline container
        const timelineDiv = document.createElement('div');
        timelineDiv.className = 'weekly-timeline';
        
        const daySchedules = state.schedules.filter(s => s.date === dateStr);
        
        const tagColorMap = {
            '講義': 'rgba(59, 130, 246, 0.4)',
            '勉強・課題': 'rgba(16, 185, 129, 0.4)',
            '趣味・遊び': 'rgba(245, 158, 11, 0.4)',
            'タスク': 'rgba(139, 92, 246, 0.4)',
            'カレンダー': 'rgba(239, 68, 68, 0.4)',
            'record': 'rgba(244, 63, 94, 0.6)'
        };

        const tagBorderMap = {
            '講義': '#3b82f6',
            '勉強・課題': '#10b981',
            '趣味・遊び': '#f59e0b',
            'タスク': '#8b5cf6',
            'カレンダー': '#ef4444',
            'record': '#f43f5e'
        };

        daySchedules.forEach(sched => {
            const [sh, sm] = sched.startTime.split(':').map(Number);
            const [eh, em] = sched.endTime.split(':').map(Number);
            
            let startMins = sh * 60 + sm;
            let endMins = eh * 60 + em;
            
            if (sh < 5) startMins += 24 * 60;
            if (eh < 5) endMins += 24 * 60;
            if (endMins < startMins) endMins = startMins + 60;

            const top = startMins - (5 * 60);
            const height = endMins - startMins;

            const block = document.createElement('div');
            block.className = `schedule-block ${sched.tag === 'record' ? 'record-block' : ''}`;
            block.style.top = `${top}px`;
            block.style.height = `${height}px`;
            block.style.backgroundColor = tagColorMap[sched.tag] || tagColorMap['タスク'];
            block.style.borderLeftColor = tagBorderMap[sched.tag] || tagBorderMap['タスク'];

            block.innerHTML = `
                <div class="schedule-title" title="${sched.title}">${sched.title}</div>
                <div class="schedule-time">${sched.startTime} - ${sched.endTime}</div>
                ${sched.memo ? `<div class="schedule-memo" title="${sched.memo}">${sched.memo}</div>` : ''}
            `;
            timelineDiv.appendChild(block);
        });

        col.appendChild(timelineDiv);
        grid.appendChild(col);
    }
}

// --- Diary ---

function renderDiaryView(dateStr) {
    if (!dateStr) return;
    const panel = document.getElementById('diary-panel');
    if (!panel) return;

    const entry = state.diary[dateStr] || {};
    const localNote = entry.localNote || '';
    const docId = entry.docId;
    const webViewLink = entry.webViewLink;

    const dateDisplay = new Date(dateStr + 'T12:00:00').toLocaleDateString('ja-JP', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
    });

    let docSection;
    if (docId && webViewLink) {
        docSection = `
            <div class="diary-doc-card linked">
                <div class="diary-doc-info">
                    <span class="diary-doc-icon">📄</span>
                    <div>
                        <div class="diary-doc-label">Googleドキュメント</div>
                        <div class="diary-doc-name">Daily Flow 日記 - ${dateStr}</div>
                    </div>
                </div>
                <a href="${webViewLink}" target="_blank" rel="noopener" class="btn primary diary-open-btn">
                    開いて編集 ↗
                </a>
            </div>`;
    } else {
        // Drive doc creation only needs GIS (OAuth), not GAPI key auth (gapiInited).
        // gapiInited is for Calendar key — tying diary to it kept the button permanently disabled.
        const canCreate = gisInited || !!(window.google && state.settings?.clientId);
        docSection = `
            <div class="diary-doc-card empty">
                <div class="diary-doc-info">
                    <span class="diary-doc-icon">📄</span>
                    <div class="diary-doc-label" style="color:var(--text-secondary);">
                        この日のGoogleドキュメントはまだありません
                    </div>
                </div>
                <button id="btn-create-diary-doc" class="btn secondary" ${canCreate ? '' : 'disabled title="Google Client IDを設定してください"'}>
                    + ドキュメントを作成
                </button>
            </div>`;
    }

    panel.innerHTML = `
        <h4 class="diary-date-heading">${dateDisplay}</h4>

        ${docSection}

        <div class="diary-note-section">
            <label class="diary-note-label">📝 ローカルメモ <span class="diary-note-hint">（オフライン対応・自動保存）</span></label>
            <textarea id="diary-local-note" class="diary-textarea" rows="14"
                placeholder="今日学んだこと、気づいたこと、明日試すこと...">${localNote}</textarea>
            <div class="diary-note-footer">
                <span id="diary-save-status" class="diary-save-status">保存しました ✓</span>
                <button id="btn-save-diary-note" class="btn primary">保存</button>
            </div>
        </div>
    `;

    // Create Google Doc
    const createBtn = document.getElementById('btn-create-diary-doc');
    if (createBtn) {
        createBtn.addEventListener('click', () => createDiaryDoc(dateStr));
    }

    // Save local note
    const saveBtn = document.getElementById('btn-save-diary-note');
    const noteArea = document.getElementById('diary-local-note');
    const saveStatus = document.getElementById('diary-save-status');

    function saveDiaryNote() {
        if (!state.diary[dateStr]) state.diary[dateStr] = {};
        state.diary[dateStr].localNote = noteArea.value;
        saveData();
        if (saveStatus) {
            saveStatus.style.opacity = '1';
            setTimeout(() => { saveStatus.style.opacity = '0'; }, 2000);
        }
    }

    if (saveBtn) saveBtn.addEventListener('click', saveDiaryNote);

    // Ctrl+S / Cmd+S shortcut
    if (noteArea) {
        let _autoSaveTimer = null;
        noteArea.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveDiaryNote();
            }
        });
        // Auto-save after 3 seconds of inactivity
        noteArea.addEventListener('input', () => {
            clearTimeout(_autoSaveTimer);
            _autoSaveTimer = setTimeout(saveDiaryNote, 3000);
        });
    }
}

async function createDiaryDoc(dateStr) {
    const btn = document.getElementById('btn-create-diary-doc');
    if (btn) { btn.disabled = true; btn.textContent = '作成中...'; }

    console.log('[Diary] createDiaryDoc — driveTokenClient:', !!driveTokenClient,
        'gisInited:', gisInited, 'gapiInited:', gapiInited,
        'window.google:', !!window.google,
        'clientId:', state.settings?.clientId ? '設定済み' : '未設定');

    // If driveTokenClient isn't ready, re-run initGAPI() (GIS script may have loaded
    // after the initial 1-second delay)
    if (!driveTokenClient) {
        if (!window.google) {
            console.error('[Diary] window.google が未定義 — GISスクリプトの読み込み失敗');
            alert('Google Identity Services の読み込みに失敗しました。ページを再読み込みしてください。');
            if (btn) { btn.disabled = false; btn.textContent = '+ ドキュメントを作成'; }
            return;
        }
        if (!state.settings?.clientId) {
            console.error('[Diary] clientId が設定されていません');
            alert('設定画面でGoogle Client IDを入力してください。');
            if (btn) { btn.disabled = false; btn.textContent = '+ ドキュメントを作成'; }
            return;
        }
        console.log('[Diary] driveTokenClient が null のため initGAPI() を再実行します');
        initGAPI();
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('[Diary] initGAPI() 再実行後 driveTokenClient:', !!driveTokenClient);
    }

    if (!driveTokenClient) {
        console.error('[Diary] initGAPI() 後も driveTokenClient が null');
        alert('Drive APIの初期化に失敗しました。ページを再読み込みしてください。');
        if (btn) { btn.disabled = false; btn.textContent = '+ ドキュメントを作成'; }
        return;
    }

    // Ensure gapi.client module is loaded before the OAuth callback fires.
    // If it isn't loaded yet, gapi.client.setToken() won't be called by GIS
    // and subsequent Drive API calls will fail with 401.
    if (window.gapi && !gapi.client) {
        console.log('[Diary] gapi.client が未ロードのため gapi.load("client") を実行');
        await new Promise(resolve => gapi.load('client', resolve));
        console.log('[Diary] gapi.client ロード完了');
    }

    const doCreate = async () => {
        try {
            if (!window.gapi) throw new Error('gapi が利用できません');
            // Load gapi.client module if still missing (rare edge case)
            if (!gapi.client) {
                await new Promise(resolve => gapi.load('client', resolve));
            }
            // Load Drive v3 discovery if not yet loaded
            if (!gapi.client.drive) {
                await gapi.client.load('drive', 'v3');
            }

            const title = `Daily Flow 日記 - ${dateStr}`;
            const response = await gapi.client.drive.files.create({
                resource: {
                    name: title,
                    mimeType: 'application/vnd.google-apps.document',
                },
                fields: 'id,webViewLink'
            });

            const { id: docId, webViewLink } = response.result;
            if (!state.diary[dateStr]) state.diary[dateStr] = {};
            state.diary[dateStr].docId = docId;
            state.diary[dateStr].webViewLink = webViewLink;
            saveData();
            renderDiaryView(dateStr);
        } catch (e) {
            console.error('Diary doc creation failed:', e);
            alert('Googleドキュメントの作成に失敗しました。\nGoogleアカウントへのアクセスを許可してください。');
            if (btn) { btn.disabled = false; btn.textContent = '+ ドキュメントを作成'; }
        }
    };

    driveAuthCallback = doCreate;
    driveTokenClient.requestAccessToken({ prompt: '' });
}

// Start
init();
