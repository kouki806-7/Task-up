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
    }
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
    renderDashboard();
    
    // Trigger Firebase sync if logged in
    if (currentUser) {
        saveToCloud();
    }
}

function generateId() {
    return Math.random().toString(36).substring(2, 9);
}

// --- DOM Elements ---
// Views
const views = document.querySelectorAll('.view');
const navLinks = document.querySelectorAll('.nav-links li[data-view]');
const navReflection = document.getElementById('nav-reflection');

// Dashboard
const formAdd = document.getElementById('add-task-form');
const inputName = document.getElementById('task-name');
const inputDuration = document.getElementById('task-duration');
const inputRoutine = document.getElementById('task-routine');
const inputTag = document.getElementById('task-tag');
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

// Reflection Modal
const modalReflection = document.getElementById('reflection-modal');
const btnSaveReflection = document.getElementById('btn-save-reflection');
const btnCancelReflection = document.getElementById('btn-cancel-reflection');
const textMemo = document.getElementById('reflection-memo');

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
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';
let tokenClient;
let gapiInited = false;
let gisInited = false;
let authCallback = null;

function initGAPI() {
    if (window.gapi && state.settings && state.settings.apiKey) {
        gapi.load('client', async () => {
            try {
                await gapi.client.init({
                    apiKey: state.settings.apiKey,
                    discoveryDocs: [DISCOVERY_DOC],
                });
                gapiInited = true;
            } catch(e) { console.error("GAPI init error", e); }
        });
    }
    if (window.google && state.settings && state.settings.clientId) {
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
        timerSelect.disabled = true;
        btnTimerStart.innerHTML = '▶ 再開';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerFinish.disabled = false;
        btnTimerCancel.style.display = 'block';
        if (btnTimerReset) btnTimerReset.style.display = 'block';
        updateTimerDisplay();
    } else {
        btnTimerStart.innerHTML = '▶ 開始';
        btnTimerStart.classList.replace('secondary', 'primary');
        btnTimerPause.style.display = 'none';
        btnTimerCancel.style.display = 'none';
        if (btnTimerReset) btnTimerReset.style.display = 'none';
        updateTimerDisplay();
    }
}

// --- Firebase Sync ---
let db = null;
let auth = null;
let currentUser = null;

function initFirebase() {
    if (window.firebase && state.settings && state.settings.firebaseConfig) {
        try {
            if (!firebase.apps.length) {
                firebase.initializeApp(state.settings.firebaseConfig);
            }
            db = firebase.firestore();
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
                    
                    fetchCloudData();
                } else {
                    currentUser = null;
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
            
            state.tasks = cloudState.tasks || [];
            state.routines = cloudState.routines || [];
            state.schedules = cloudState.schedules || [];
            state.history = cloudState.history || {};
            state.lastDate = cloudState.lastDate || '';
            if (cloudState.settings) {
                state.settings = { ...state.settings, ...cloudState.settings };
            }
            if (cloudState.timer) {
                if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
                state.timer = cloudState.timer;
            }
            state.memos = cloudState.memos || [];

            // Re-render views
            renderDashboard();
            syncTimerUI();   // resume timer display if it was running on another device
            if (document.getElementById('view-history').classList.contains('active')) renderHistoryCalendar();
            if (document.getElementById('view-schedule').classList.contains('active')) renderWeeklySchedule();
            
            const syncStatus = document.getElementById('sync-status');
            if (syncStatus) {
                syncStatus.textContent = '同期済 ✓';
                syncStatus.style.color = 'var(--success-color)';
            }
        } else {
            // First login, upload local data
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
            memos: state.memos
        };
        await db.collection('users').doc(currentUser.uid).set(dataToSave);
        
        if (syncStatus) {
            syncStatus.textContent = '同期済 ✓';
            syncStatus.style.color = 'var(--success-color)';
        }
    } catch (e) {
        console.error("Error saving to cloud", e);
        const syncStatus = document.getElementById('sync-status');
        if (syncStatus) {
            syncStatus.textContent = '同期失敗 ✕';
            syncStatus.style.color = 'var(--danger-color)';
        }
    }
}

// --- Weather Fetch ---
async function fetchWeather() {
    const weatherDisplay = document.getElementById('weather-display');
    if (!weatherDisplay) return;

    // Use Tokyo coordinates by default
    const lat = 35.6895;
    const lon = 139.6917;

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=Asia%2FTokyo`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        
        const code = data.current_weather.weathercode;
        
        let icon = '🌤️'; // default
        let desc = '不明';

        // WMO Weather interpretation codes (https://open-meteo.com/en/docs)
        if (code === 0) { icon = '☀️'; desc = '快晴'; }
        else if (code === 1 || code === 2 || code === 3) { icon = '⛅'; desc = '晴れ/曇り'; }
        else if (code === 45 || code === 48) { icon = '🌫️'; desc = '霧'; }
        else if (code >= 51 && code <= 55) { icon = '🌧️'; desc = '霧雨'; }
        else if (code >= 61 && code <= 65) { icon = '☔'; desc = '雨'; }
        else if (code >= 71 && code <= 75) { icon = '⛄'; desc = '雪'; }
        else if (code >= 80 && code <= 82) { icon = '🌦️'; desc = 'にわか雨'; }
        else if (code >= 85 && code <= 86) { icon = '🌨️'; desc = '雪'; }
        else if (code >= 95) { icon = '⛈️'; desc = '雷雨'; }

        weatherDisplay.textContent = icon;
        weatherDisplay.title = `${desc} (${data.current_weather.temperature}℃)`;
    } catch (e) {
        console.error("Weather fetch failed:", e);
        weatherDisplay.textContent = '☁️';
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
    renderHistoryCalendar();
    fetchWeather();
    syncTimerUI();
    
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

    if (viewId === 'history') {
        renderHistoryCalendar();
    } else if (viewId === 'stats') {
        renderStats('daily');
        setActiveStatBtn(btnStatDaily);
    } else if (viewId === 'schedule') {
        renderWeeklySchedule();
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

    navReflection.addEventListener('click', openReflectionModal);
    btnCancelReflection.addEventListener('click', () => modalReflection.classList.remove('active'));
    btnSaveReflection.addEventListener('click', saveReflection);

    // Adding Task
    formAdd.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = inputName.value.trim();
        const duration = parseInt(inputDuration.value) || 0;
        const isRoutine = inputRoutine.value === 'true';
        const tag = inputTag.value;

        if (text) {
            addTask(text, duration, isRoutine, tag);
            inputName.value = '';
            inputDuration.value = '';
            inputRoutine.value = 'false';
            inputTag.value = 'タスク';
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
        btnSyncGcal.addEventListener('click', () => {
            if (!gapiInited || !gisInited) {
                alert("Google APIが初期化されていません。設定画面でキーが正しく入力されているか確認してください。");
                return;
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
    if (btnTimerStart) {
        btnTimerStart.addEventListener('click', () => {
            const taskId = timerSelect.value;
            if (!taskId) return alert("タスクを選択してください");
            
            // Toggle Logic
            if (state.timer.isRunning) {
                // Pause action
                const elapsed = Math.floor((Date.now() - state.timer.startTime) / 1000);
                state.timer.accumulatedSeconds += elapsed;
                state.timer.isRunning = false;
                state.timer.startTime = null;
                saveData();
                
                if (timerInterval) clearInterval(timerInterval);
                timerInterval = null;
                
                syncTimerUI();
            } else {
                // Start/Resume action
                // If the task has changed, reset the accumulated time to avoid lingering bugs
                if (state.timer.taskId !== taskId) {
                    state.timer.accumulatedSeconds = 0;
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

                let dateStr = getTodayString();
                if (now.getHours() < 5) {
                    const prevDay = new Date(now);
                    prevDay.setDate(prevDay.getDate() - 1);
                    dateStr = prevDay.toLocaleDateString('en-CA');
                }

                state.schedules.push({
                    id: generateId(),
                    title: `⏱ ${task.text}`,
                    date: dateStr,
                    startTime: startStr,
                    endTime: endStr,
                    tag: 'record',
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
        });
    }

    if (btnTimerReset) {
        btnTimerReset.addEventListener('click', () => {
            if (timerInterval) clearInterval(timerInterval);
            timerInterval = null;

            const currentTaskId = state.timer.taskId;
            state.timer = { taskId: currentTaskId, startTime: null, isRunning: false, accumulatedSeconds: 0 };

            saveData();
            // syncTimerUI shows idle state but keeps task in dropdown
            timerSelect.disabled = false;
            btnTimerFinish.disabled = true;
            btnTimerCancel.style.display = 'none';
            btnTimerReset.style.display = 'none';
            btnTimerStart.innerHTML = '▶ 開始';
            btnTimerStart.classList.replace('secondary', 'primary');
            timerDisplay.textContent = '00:00:00';
            updateTimerSelect();
            if (currentTaskId) timerSelect.value = currentTaskId;
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

        const taskMsg = taskAdded > 0 ? `\nタスク自動登録(manaba): ${taskAdded}件` : '';
        alert(`Googleカレンダーと自動同期しました！\n（新規: ${added}件, 更新: ${updated}件）${taskMsg}`);
        console.log(`[Auto-sync] done. added=${added}, updated=${updated}, taskAdded=${taskAdded}`);
        
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

    authCallback = () => fetchGoogleCalendarEvents(true);

    try {
        if (gapi.client.getToken() !== null) {
            fetchGoogleCalendarEvents(true);
        } else {
            // Use prompt: 'none' for a completely silent attempt. 
            // Requires a valid session in the browser.
            const options = { prompt: 'none' };
            if (state.settings.googleEmail) {
                options.login_hint = state.settings.googleEmail;
            }
            isSilentAuthAttempt = true;
            tokenClient.requestAccessToken(options);
        }
    } catch (e) {
        console.log('[Auto-sync] silent auth skipped or failed:', e);
    }
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
                // Simplified schedule logic for parsing
                const day = new Date().getDay();
                state.schedules.push({ id: generateId(), title: name, dayIndex: day, startHour: sh + sm/60, endHour: eh + em/60, tag: 'カレンダー', memo: '' });
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
        progressText.textContent = "すべて完了しました！振り返りをしましょう。";
        progressRing.style.stroke = "var(--success-color)";
    } else {
        progressText.textContent = "その調子！頑張りましょう。";
        progressRing.style.stroke = "var(--primary-color)";
    }
}

// --- Reflection Modal ---
function openReflectionModal() {
    const total = state.tasks.length;
    const completed = state.tasks.filter(t => t.completed).length;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

    document.getElementById('modal-completion-rate').textContent = `${percent}%`;
    document.getElementById('modal-task-count').textContent = `${completed}/${total}`;
    
    // Check if we already reflected today
    const today = getTodayString();
    if (state.history[today]) {
        textMemo.value = state.history[today].memo;
    } else {
        textMemo.value = '';
    }

    modalReflection.classList.add('active');
}

function saveReflection() {
    const today = getTodayString();
    const total = state.tasks.length;
    const completed = state.tasks.filter(t => t.completed).length;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

    const durationByTag = {};
    state.tasks.filter(t => t.completed).forEach(t => {
        const tag = t.tag || 'タスク';
        if (!durationByTag[tag]) durationByTag[tag] = 0;
        durationByTag[tag] += (t.duration || 0);
    });

    state.history[today] = {
        rate: percent,
        tasksCompleted: completed,
        tasksTotal: total,
        memo: textMemo.value.trim(),
        durationByTag
    };

    saveData();
    modalReflection.classList.remove('active');
    
    // Optionally show a toast/alert
    alert("振り返りを保存しました！お疲れ様でした。");
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

    const tagCounts = { '講義':0, '勉強・課題':0, '趣味・遊び':0, 'タスク':0, 'カレンダー':0 };
    let totalMins = 0;

    dates.forEach(dateStr => {
        const h = state.history[dateStr];
        if (h && h.durationByTag) {
            Object.keys(h.durationByTag).forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + h.durationByTag[tag];
                totalMins += h.durationByTag[tag];
            });
        }
    });

    // Achievement Rate
    let plannedTotal = 0;
    let recordedTotal = 0;
    state.schedules.forEach(s => {
        if (!s.startTime || !s.endTime) return;
        const [sh, sm] = s.startTime.split(':').map(Number);
        const [eh, em] = s.endTime.split(':').map(Number);
        
        let startH = sh + sm / 60;
        let endH = eh + em / 60;
        if (endH < startH) endH += 24;
        const duration = endH - startH;
        
        if (s.tag === 'record') {
            recordedTotal += duration;
        } else if (s.tag !== 'カレンダー' && s.tag !== 'calendar') {
            plannedTotal += duration;
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

    statsContent.innerHTML = '';
    
    let hasData = false;
    for (let t in tagCounts) {
        if (tagCounts[t] > 0) hasData = true;
    }
    if (!hasData) {
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

    // Sort by duration descending
    const sortedTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]);

    sortedTags.forEach(tag => {
        if (tagCounts[tag] === 0) return;
        const mins = tagCounts[tag];
        const hours = Math.floor(mins / 60);
        const m = mins % 60;
        const timeStr = hours > 0 ? `${hours}時間 ${m}分` : `${m}分`;
        const percent = Math.round((mins / totalMins) * 100);
        
        const color = tagColorMap[tag] || 'var(--tag-task)';
        
        statsContent.innerHTML += `
            <div class="stat-item">
                <div class="stat-header">
                    <span>${tag}</span>
                    <span>${timeStr} (${percent}%)</span>
                </div>
                <div class="stat-bar-bg">
                    <div class="stat-bar-fill" style="width: ${percent}%; background: ${color}"></div>
                </div>
            </div>
        `;
    });
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

// Start
init();
