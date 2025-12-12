const telegramWebApp = window.Telegram?.WebApp ?? null;
const socket = io({ autoConnect: false });
const FALLBACK_BETS = [1, 5, 10];

const elements = {
  balanceChip: document.getElementById('balanceChip'),
  timeLabel: document.getElementById('timeLabel'),
  progress: document.getElementById('timeProgress'),
  matchState: document.getElementById('matchState'),
  playerName: document.getElementById('playerName'),
  opponentName: document.getElementById('opponentName'),
  playerClicks: document.getElementById('playerClicks'),
  opponentClicks: document.getElementById('opponentClicks'),
  pulseButton: document.getElementById('pulseButton'),
  queueButton: document.getElementById('queueButton'),
  resultModal: document.getElementById('resultModal'),
  resultTitle: document.getElementById('resultTitle'),
  resultMessage: document.getElementById('resultMessage'),
  modalClose: document.getElementById('modalClose'),
  matchLog: document.getElementById('matchLog'),
  rankingList: document.getElementById('rankingList'),
  playerCard: document.getElementById('playerCard'),
  opponentCard: document.getElementById('opponentCard'),
  closeAppButton: document.getElementById('closeAppButton'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  loadingMessage: document.getElementById('loadingMessage'),
  betOptions: document.getElementById('betOptions'),
  selectedBetLabel: document.getElementById('selectedBetLabel'),
  potLabel: document.getElementById('potLabel'),
  houseFeeLabel: document.getElementById('houseFeeLabel'),
};

const state = {
  userId: null,
  nickname: null,
  roomId: null,
  opponent: null,
  clicks: { me: 0, opponent: 0 },
  duration: 10_000,
  timeLeft: 10_000,
  balance: 0,
  isTelegram: Boolean(telegramWebApp),
  telegramInitData: null,
  houseCut: 0.1,
  betOptions: [],
  betAmount: null,
  waitingQueue: false,
  currentBetSummary: null,
};

let audioContext;

function getOrCreateId(key) {
  const stored = localStorage.getItem(key);
  if (stored) {
    return stored;
  }
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

function getOrCreateNickname() {
  const key = 'pulse-nickname';
  const stored = localStorage.getItem(key);
  if (stored) {
    return stored;
  }
  const random = `Player-${Math.floor(Math.random() * 900 + 100)}`;
  localStorage.setItem(key, random);
  return random;
}

function showLoading(message = 'Cargando...') {
  if (!elements.loadingOverlay) {
    return;
  }
  elements.loadingMessage.textContent = message;
  elements.loadingOverlay.hidden = false;
}

function hideLoading() {
  if (!elements.loadingOverlay) {
    return;
  }
  elements.loadingOverlay.hidden = true;
}

function applyTelegramTheme(scheme = 'dark') {
  const theme = scheme === 'light' ? 'light' : 'dark';
  document.body.dataset.theme = theme;
}

async function resolveIdentity() {
  if (state.isTelegram && telegramWebApp) {
    showLoading('Conectando a Telegram...');
    telegramWebApp.ready();
    telegramWebApp.expand();
    const { user } = telegramWebApp.initDataUnsafe ?? {};
    if (!user?.id) {
      throw new Error('Telegram no envió datos de usuario');
    }
    state.userId = String(user.id);
    state.nickname = user.username || [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Jugador';
    state.telegramInitData = telegramWebApp.initData || '';
    applyTelegramTheme(telegramWebApp.colorScheme);
    telegramWebApp.onEvent('themeChanged', () => applyTelegramTheme(telegramWebApp.colorScheme));
    elements.closeAppButton.hidden = false;
    elements.closeAppButton.addEventListener('click', () => telegramWebApp.close());
  } else {
    state.userId = getOrCreateId('pulse-user-id');
    state.nickname = getOrCreateNickname();
    applyTelegramTheme('dark');
    elements.closeAppButton.hidden = true;
  }
}

function connectSocket() {
  socket.connect();
}

function initUI() {
  elements.playerName.textContent = state.nickname;
  setMatchState(state.isTelegram ? 'Conectando a Telegram...' : 'Conectando...');
  updateClicks();
  updateTimer(10_000);
  elements.pulseButton.disabled = true;
  updateBetSummary(null);
  updateQueueButton();
}

function prepareAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playClickTone() {
  if (!audioContext) {
    return;
  }
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = 'square';
  osc.frequency.value = 420;
  gain.gain.value = 0.12;
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.08);
}

function updateQueueButton() {
  if (!elements.queueButton) {
    return;
  }
  let label = 'Selecciona apuesta';
  let disabled = true;

  if (!state.betAmount) {
    disabled = true;
  } else if (state.roomId) {
    label = 'Partida en curso';
    disabled = true;
  } else if (state.waitingQueue) {
    label = 'Buscando rival...';
    disabled = true;
  } else {
    label = `Buscar partida · ${state.betAmount.toFixed(1)} cr`;
    disabled = false;
  }

  elements.queueButton.textContent = label;
  elements.queueButton.disabled = disabled;
}

function renderBetButtons(bets = FALLBACK_BETS) {
  state.betOptions = bets.length ? bets : FALLBACK_BETS;
  elements.betOptions.innerHTML = '';
  state.betOptions.forEach((amount) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bet-option';
    btn.dataset.amount = String(amount);
    btn.textContent = `${amount.toFixed(1)} cr`;
    btn.addEventListener('click', () => setBetAmount(amount));
    elements.betOptions.appendChild(btn);
  });
  setBetAmount(state.betOptions[0] ?? null);
}

function setBetAmount(amount) {
  state.betAmount = Number(amount);
  if (Number.isNaN(state.betAmount)) {
    state.betAmount = null;
  }
  const buttons = elements.betOptions?.querySelectorAll('.bet-option') ?? [];
  buttons.forEach((btn) => {
    const isActive = Number(btn.dataset.amount) === state.betAmount;
    btn.classList.toggle('active', isActive);
  });
  updateBetSummary(state.currentBetSummary);
  updateQueueButton();
}

function updateBetSummary(summary) {
  state.currentBetSummary = summary ?? null;
  const amount = summary?.amountPerPlayer ?? state.betAmount ?? 0;
  const pot = summary?.pot ?? (amount ? amount * 2 : 0);
  const houseFee = summary?.houseFee ?? (pot * state.houseCut);
  elements.selectedBetLabel.textContent = amount ? `${amount.toFixed(1)} créditos` : '—';
  elements.potLabel.textContent = pot ? pot.toFixed(1) : '0.0';
  elements.houseFeeLabel.textContent = houseFee ? houseFee.toFixed(1) : '0.0';
}

function requestQueue() {
  if (!state.betAmount) {
    setMatchState('Selecciona una apuesta antes de jugar');
    return;
  }
  if (state.waitingQueue || state.roomId) {
    return;
  }
  state.waitingQueue = true;
  updateQueueButton();
  setMatchState(`Buscando rival para ${state.betAmount.toFixed(1)} créditos...`);
  socket.emit('queue:join', { amount: state.betAmount });
}

function sendPulse() {
  if (!state.roomId) {
    return;
  }
  socket.emit('click');
  state.clicks.me += 1;
  updateClicks();
  playClickTone();
  elements.pulseButton.classList.add('bump');
  setTimeout(() => elements.pulseButton.classList.remove('bump'), 120);
}

function resetRound() {
  state.roomId = null;
  state.opponent = null;
  state.clicks = { me: 0, opponent: 0 };
  state.timeLeft = state.duration;
  state.currentBetSummary = null;
  state.waitingQueue = false;
  elements.opponentName.textContent = 'Buscando...';
  updateClicks();
  updateTimer(state.duration);
  elements.pulseButton.disabled = true;
  updateBetSummary(null);
  updateQueueButton();
}

function openModal(title, message) {
  elements.resultTitle.textContent = title;
  elements.resultMessage.textContent = message;
  elements.resultModal.hidden = false;
}

function closeModal() {
  elements.resultModal.hidden = true;
}

function setMatchState(text) {
  elements.matchState.textContent = text;
}

function updateClicks(remoteClicks) {
  if (remoteClicks) {
    const myValue = remoteClicks[state.userId] ?? 0;
    const opponentId = state.opponent?.userId;
    const rivalValue = opponentId ? remoteClicks[opponentId] ?? 0 : 0;
    state.clicks.me = myValue;
    state.clicks.opponent = rivalValue;
  }
  elements.playerClicks.textContent = state.clicks.me;
  elements.opponentClicks.textContent = state.clicks.opponent;
  updateLeaders();
}

function updateLeaders() {
  elements.playerCard.classList.toggle('active', state.clicks.me >= state.clicks.opponent && Boolean(state.roomId));
  elements.opponentCard.classList.toggle('active', state.clicks.opponent > state.clicks.me && Boolean(state.roomId));
}

function updateTimer(timeLeft) {
  state.timeLeft = timeLeft;
  const seconds = (timeLeft / 1000).toFixed(1);
  elements.timeLabel.textContent = `${seconds}s`;
  const progress = 100 - Math.min(100, (timeLeft / state.duration) * 100);
  elements.progress.style.width = `${progress}%`;
}

function updateBalance(balance) {
  state.balance = balance;
  elements.balanceChip.textContent = `Saldo: ${balance.toFixed(1)}`;
}

function createMatchLogItem(result) {
  const li = document.createElement('li');
  const winnerText = result.winnerId
    ? `Ganador: ${result.players.find((p) => p.userId === result.winnerId)?.nickname ?? '???'}`
    : 'Empate';
  const betPot = Number(result.bet?.pot ?? 0);
  const betText = betPot ? ` · Bote ${betPot.toFixed(1)}` : '';
  li.textContent = `${new Date(result.timestamp).toLocaleTimeString()} · ${winnerText}${betText}`;
  return li;
}

function appendMatchLog(result) {
  const li = createMatchLogItem(result);
  elements.matchLog.prepend(li);
  while (elements.matchLog.childElementCount > 6) {
    elements.matchLog.removeChild(elements.matchLog.lastChild);
  }
}

async function refreshMetaPanels() {
  try {
    const [rankingRes, resultsRes] = await Promise.all([
      fetch('/api/ranking'),
      fetch('/api/results'),
    ]);
    if (rankingRes.ok) {
      const data = await rankingRes.json();
      renderRanking(data.ranking ?? []);
    }
    if (resultsRes.ok) {
      const data = await resultsRes.json();
      renderMatchLog(data.matches ?? []);
    }
  } catch (err) {
    console.warn('Meta refresh failed', err);
  }
}

function renderRanking(list) {
  elements.rankingList.innerHTML = '';
  list.slice(0, 5).forEach((entry) => {
    const li = document.createElement('li');
    li.textContent = `${entry.nickname} · ${entry.wins}W / ${entry.games}G`;
    elements.rankingList.appendChild(li);
  });
}

function renderMatchLog(matches) {
  elements.matchLog.innerHTML = '';
  matches.slice(0, 6).forEach((match) => {
    elements.matchLog.appendChild(createMatchLogItem(match));
  });
}

function bindEvents() {
  elements.queueButton.addEventListener('click', () => {
    prepareAudio();
    requestQueue();
  });

  elements.pulseButton.addEventListener('pointerdown', () => {
    prepareAudio();
    sendPulse();
  });

  elements.modalClose.addEventListener('click', () => {
    closeModal();
    requestQueue();
  });

  elements.resultModal.addEventListener('click', (evt) => {
    if (evt.target === elements.resultModal) {
      closeModal();
    }
  });
}

function wireSocket() {
  socket.on('connect', () => {
    socket.emit('register', {
      userId: state.userId,
      nickname: state.nickname,
      telegramInitData: state.isTelegram ? state.telegramInitData : null,
    });
  });

  socket.on('register:ack', (payload) => {
    hideLoading();
    state.nickname = payload.nickname;
    state.houseCut = payload.houseCut ?? state.houseCut;
    elements.playerName.textContent = payload.nickname;
    updateBalance(payload.balance);
    renderBetButtons(payload.bets ?? FALLBACK_BETS);
    updateQueueButton();
    setMatchState('Listo para jugar');
  });

  socket.on('queue:joined', (payload = {}) => {
    if (payload.betAmount) {
      updateBetSummary({
        amountPerPlayer: payload.betAmount,
        pot: payload.pot,
        houseFee: payload.houseFee,
      });
    }
    state.waitingQueue = payload.status !== 'matched';
    updateQueueButton();
    if (state.waitingQueue) {
      const waitingAmount = Number(payload.betAmount ?? state.betAmount ?? 0);
      if (waitingAmount) {
        setMatchState(`Esperando rival para ${waitingAmount.toFixed(1)} créditos...`);
      }
    }
  });

  socket.on('match:found', ({ roomId, opponent, bet }) => {
    state.roomId = roomId;
    state.opponent = opponent;
    state.clicks = { me: 0, opponent: 0 };
    elements.opponentName.textContent = opponent?.nickname ?? 'Rival';
    updateClicks();
    state.waitingQueue = false;
    updateBetSummary(bet ?? state.currentBetSummary);
    updateQueueButton();
    setMatchState('Rival encontrado. Prepárate!');
  });

  socket.on('game:start', ({ duration, bet }) => {
    state.duration = duration;
    state.timeLeft = duration;
    state.clicks = { me: 0, opponent: 0 };
    updateTimer(duration);
    updateClicks();
    state.currentBetSummary = bet ?? state.currentBetSummary;
    updateBetSummary(state.currentBetSummary);
    elements.pulseButton.disabled = false;
    const potText = state.currentBetSummary?.pot ? ` · Bote ${state.currentBetSummary.pot.toFixed(1)}` : '';
    setMatchState(`¡Dale con todo!${potText}`);
  });

  socket.on('game:tick', ({ timeLeft }) => {
    updateTimer(timeLeft);
    if (timeLeft <= 0) {
      elements.pulseButton.disabled = true;
    }
  });

  socket.on('game:update', ({ clicks }) => {
    updateClicks(clicks);
  });

  socket.on('game:result', (payload) => {
    state.currentBetSummary = payload.bet ?? state.currentBetSummary;
    updateBetSummary(state.currentBetSummary);
    elements.pulseButton.disabled = true;
    state.waitingQueue = false;
    updateQueueButton();
    setMatchState('Partida finalizada');
    refreshMetaPanels();

    const myScore = payload.players.find((p) => p.userId === state.userId);
    const opponentScore = payload.players.find((p) => p.userId === state.opponent?.userId);
    const myPayout = payload.payouts?.find((p) => p.userId === state.userId)?.amount ?? 0;
    const potText = state.currentBetSummary?.pot ? state.currentBetSummary.pot.toFixed(1) : null;

    let title = 'Empate';
    let message = potText ? `Bote ${potText}. Ambos recuperan su crédito.` : 'Ambos recuperan su crédito.';
    if (payload.winnerId) {
      if (payload.winnerId === state.userId) {
        title = '¡Ganaste!';
        const payoutText = myPayout ? ` +${myPayout.toFixed(1)} créditos.` : '';
        message = `Marcador ${myScore?.clicks ?? 0} - ${opponentScore?.clicks ?? 0}.${payoutText}`;
      } else {
        title = 'Derrota';
        message = `Marcador ${myScore?.clicks ?? 0} - ${opponentScore?.clicks ?? 0}. Intenta de nuevo.`;
      }
    }

    openModal(title, message);
    resetRound();
  });

  socket.on('balance:update', ({ balance }) => updateBalance(balance));

  socket.on('warning', ({ message }) => setMatchState(message));

  socket.on('error', ({ message }) => {
    state.waitingQueue = false;
    updateQueueButton();
    setMatchState(message);
  });
}

async function bootstrap() {
  try {
    await resolveIdentity();
    initUI();
    bindEvents();
    wireSocket();
    connectSocket();
    refreshMetaPanels();
    setInterval(refreshMetaPanels, 10_000);
  } catch (err) {
    console.error(err);
    setMatchState(err.message ?? 'Error iniciando la app');
    hideLoading();
  }
}

bootstrap();
