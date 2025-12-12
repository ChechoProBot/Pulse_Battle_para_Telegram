import { randomUUID } from 'crypto';
import BetManager from './betManager.js';

const GAME_DURATION_MS = 10_000;
const DEFAULT_BALANCE = 20;
const DEFAULT_BETS = [1, 5, 10];
const HOUSE_CUT_PERCENTAGE = 0.1;
const TICK_RATE_MS = 100;
const MIN_CLICK_INTERVAL_MS = 60;
const MAX_CLICKS_PER_SECOND = 15;
const RESULTS_LIMIT = 25;

export default class GameManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.players = new Map();
    this.socketMeta = new Map();
    this.results = [];
    this.ranking = new Map();
    this.houseBalance = 0;
    this.verifyTelegramInitData = options.verifyTelegramInitData || null;
    this.allowedBets = (options.allowedBets || DEFAULT_BETS).slice().sort((a, b) => a - b);
    this.betManager = new BetManager({
      houseCutPercentage: options.houseCutPercentage ?? HOUSE_CUT_PERCENTAGE,
    });
  }

  handleConnection(socket) {
    console.log(`[connect] ${socket.id}`);
    socket.on('register', (payload) => this.registerPlayer(socket, payload));
    socket.on('queue:join', (payload) => this.enqueuePlayer(socket, payload));
    socket.on('click', () => this.handleClick(socket));
    socket.on('disconnect', () => this.handleDisconnect(socket));
  }

  registerPlayer(socket, payload = {}) {
    const { telegramInitData = null } = payload;
    let { userId, nickname = 'Player' } = payload;

    if (telegramInitData) {
      if (!this.verifyTelegramInitData) {
        socket.emit('error', { message: 'Telegram no está habilitado en el servidor' });
        socket.disconnect(true);
        return;
      }

      try {
        const data = this.verifyTelegramInitData(telegramInitData);
        userId = String(data.user.id);
        const tgName = data.user.username
          || [data.user.first_name, data.user.last_name].filter(Boolean).join(' ');
        if (tgName?.trim()) {
          nickname = tgName;
        }
      } catch (err) {
        socket.emit('error', { message: err.message || 'Auth de Telegram inválida' });
        socket.disconnect(true);
        return;
      }
    }

    if (!userId) {
      socket.emit('error', { message: 'Falta userId' });
      return;
    }

    const trimmedNick = nickname.trim().slice(0, 18) || 'Player';
    const existing = this.players.get(userId);

    if (existing && existing.socketId && existing.socketId !== socket.id) {
      const previousSocket = this.io.sockets.sockets.get(existing.socketId);
      if (previousSocket) {
        previousSocket.disconnect(true);
      }
    }

    const balance = existing ? existing.balance : DEFAULT_BALANCE;
    this.players.set(userId, {
      userId,
      nickname: trimmedNick,
      balance,
      socketId: socket.id,
    });

    this.socketMeta.set(socket.id, {
      userId,
      roomId: null,
      lastClickTs: 0,
      cpsWindowStart: 0,
      clicksThisWindow: 0,
    });

    socket.emit('register:ack', {
      userId,
      nickname: trimmedNick,
      balance,
      bets: this.allowedBets,
      houseCut: this.betManager.houseCutPercentage,
    });
    console.log(`[register] ${trimmedNick} (${userId}) balance=${balance}`);
  }

  enqueuePlayer(socket, payload = {}) {
    const meta = this.socketMeta.get(socket.id);
    if (!meta) {
      socket.emit('error', { message: 'Regístrate primero' });
      return;
    }

    if (meta.roomId) {
      socket.emit('error', { message: 'Partida en curso' });
      return;
    }

    const player = this.players.get(meta.userId);
    if (!player) {
      socket.emit('error', { message: 'Jugador inválido' });
      return;
    }

    const betAmount = Number(payload?.amount ?? 0);
    if (!Number.isFinite(betAmount) || !this.allowedBets.includes(betAmount)) {
      socket.emit('error', { message: 'Apuesta inválida' });
      return;
    }

    if (this.betManager.hasEscrow(meta.userId)) {
      socket.emit('error', { message: 'Ya creaste una apuesta. Espera al rival.' });
      return;
    }

    if (player.balance < betAmount) {
      socket.emit('error', { message: 'Saldo insuficiente para esa apuesta' });
      return;
    }

    this.debitPlayer(player, betAmount);

    let match;
    try {
      match = this.betManager.queuePlayer(meta.userId, betAmount);
    } catch (err) {
      this.creditPlayer(player, betAmount);
      socket.emit('error', { message: err.message || 'No se pudo crear la apuesta' });
      return;
    }

    const queuePayload = {
      status: match.matched ? 'matched' : 'waiting',
      betAmount,
      pot: betAmount * 2,
      houseFee: betAmount * 2 * this.betManager.houseCutPercentage,
    };
    socket.emit('queue:joined', queuePayload);
    console.log(`[bet] ${player.nickname} (${meta.userId}) apuesta ${betAmount}`);

    if (match.matched) {
      this.createRoom([meta.userId, match.opponentId], betAmount);
    }
  }

  createRoom(userIds, betAmount) {
    const socketEntries = userIds.map((userId) => {
      const player = this.players.get(userId);
      const socket = player ? this.io.sockets.sockets.get(player.socketId) : null;
      return { userId, player, socket };
    });

    if (socketEntries.some(({ socket }) => !socket)) {
      const released = this.betManager.releasePlayers(userIds, 'oponente-offline');
      released.forEach(({ userId, amount }) => this.creditPlayerById(userId, amount));
      return false;
    }

    const roomId = randomUUID();
    const room = {
      id: roomId,
      status: 'waiting',
      players: {},
      startTime: null,
      timer: null,
      bet: this.betManager.attachRoom(roomId, betAmount, userIds),
    };

    socketEntries.forEach(({ userId, player, socket }) => {
      room.players[userId] = { socketId: socket.id, clicks: 0 };
      this.socketMeta.get(socket.id).roomId = roomId;
      socket.join(roomId);
    });

    this.rooms.set(roomId, room);
    console.log(`[room] ${roomId} listo con ${userIds.join(' vs ')}`);

    socketEntries.forEach(({ userId, player, socket }) => {
      const opponent = socketEntries.find((entry) => entry.userId !== userId)?.player;
      socket.emit('match:found', {
        roomId,
        bet: room.bet,
        opponent: opponent
          ? { userId: opponent.userId, nickname: opponent.nickname }
          : null,
      });
    });

    this.startGame(roomId);
    return true;
  }

  startGame(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    room.status = 'running';
    room.startTime = Date.now();

    this.broadcastRoom(roomId, 'game:start', {
      roomId,
      duration: GAME_DURATION_MS,
      timeLeft: GAME_DURATION_MS,
      bet: room.bet,
    });

    room.timer = setInterval(() => {
      const elapsed = Date.now() - room.startTime;
      const timeLeft = Math.max(GAME_DURATION_MS - elapsed, 0);
      this.broadcastRoom(roomId, 'game:tick', { timeLeft });

      if (timeLeft === 0) {
        this.finishGame(roomId, 'time');
      }
    }, TICK_RATE_MS);
  }

  handleClick(socket) {
    const meta = this.socketMeta.get(socket.id);
    if (!meta || !meta.roomId) {
      return;
    }

    const room = this.rooms.get(meta.roomId);
    if (!room || room.status !== 'running') {
      return;
    }

    const playerState = room.players[meta.userId];
    if (!playerState) {
      return;
    }

    const now = Date.now();
    if (now - meta.lastClickTs < MIN_CLICK_INTERVAL_MS) {
      return;
    }

    if (now - meta.cpsWindowStart >= 1_000) {
      meta.cpsWindowStart = now;
      meta.clicksThisWindow = 0;
    }

    if (meta.clicksThisWindow >= MAX_CLICKS_PER_SECOND) {
      socket.emit('warning', { message: 'Demasiados clicks. Respira :)' });
      return;
    }

    meta.clicksThisWindow += 1;
    meta.lastClickTs = now;

    playerState.clicks += 1;
    this.broadcastRoom(meta.roomId, 'game:update', {
      clicks: this.buildClickSnapshot(room),
    });
  }

  finishGame(roomId, reason, options = {}) {
    const { forfeitingUserId = null } = options;
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    if (room.timer) {
      clearInterval(room.timer);
    }

    room.status = 'ended';

    const playerEntries = Object.entries(room.players);
    const standings = playerEntries
      .map(([userId, state]) => ({ userId, clicks: state.clicks }))
      .sort((a, b) => b.clicks - a.clicks);

    let winnerId = null;
    if (standings[0] && standings[1]) {
      if (standings[0].clicks > standings[1].clicks) {
        winnerId = standings[0].userId;
      }
    }

    if (!winnerId && forfeitingUserId) {
      winnerId = standings.find((entry) => entry.userId !== forfeitingUserId)?.userId ?? null;
    }

    const participantIds = playerEntries.map(([id]) => id);
    this.updateGamesPlayed(participantIds);
    const settlement = this.betManager.settle(roomId, winnerId);

    if (settlement) {
      settlement.payouts.forEach(({ userId, amount }) => {
        this.creditPlayerById(userId, amount);
        if (winnerId && userId === winnerId) {
          const stats = this.ensureRanking(userId);
          stats.wins += 1;
          stats.creditsEarned += amount;
        }
      });
      this.houseBalance += settlement.houseFee;
      room.bet = settlement.bet;
    }

    const summary = playerEntries.map(([userId, state]) => {
      const player = this.players.get(userId);
      return {
        userId,
        nickname: player?.nickname ?? 'Anon',
        clicks: state.clicks,
        balance: player?.balance ?? 0,
      };
    });

    this.recordResult({ roomId, winnerId, reason, players: summary, bet: room.bet });

    this.broadcastRoom(roomId, 'game:result', {
      roomId,
      winnerId,
      players: summary,
      houseBalance: this.houseBalance,
      bet: room.bet,
      payouts: settlement?.payouts ?? [],
    });

    playerEntries.forEach(([userId, state]) => {
      const player = this.players.get(userId);
      if (player) {
        const socket = this.io.sockets.sockets.get(state.socketId);
        if (socket) {
          socket.leave(roomId);
        }
      }
    });

    playerEntries.forEach(([userId]) => {
      const player = this.players.get(userId);
      if (player) {
        const socketMeta = this.socketMeta.get(player.socketId);
        if (socketMeta) {
          socketMeta.roomId = null;
          socketMeta.clicksThisWindow = 0;
          socketMeta.lastClickTs = 0;
        }
      }
    });

    this.rooms.delete(roomId);
    console.log(`[result] ${roomId} winner=${winnerId ?? 'tie'}`);
  }

  emitBalance(player) {
    const socket = this.io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('balance:update', { balance: player.balance });
    }
  }

  debitPlayer(player, amount) {
    player.balance -= amount;
    this.emitBalance(player);
  }

  creditPlayer(player, amount) {
    player.balance += amount;
    this.emitBalance(player);
  }

  creditPlayerById(userId, amount) {
    if (!amount) {
      return;
    }
    const player = this.players.get(userId);
    if (player) {
      this.creditPlayer(player, amount);
    }
  }

  buildClickSnapshot(room) {
    const snapshot = {};
    Object.entries(room.players).forEach(([userId, state]) => {
      snapshot[userId] = state.clicks;
    });
    return snapshot;
  }

  recordResult(result) {
    this.results.unshift({ ...result, timestamp: Date.now() });
    this.results = this.results.slice(0, RESULTS_LIMIT);
  }

  handleDisconnect(socket) {
    const meta = this.socketMeta.get(socket.id);
    this.socketMeta.delete(socket.id);

    if (!meta) {
      console.log(`[disconnect] ${socket.id}`);
      return;
    }

    console.log(`[disconnect] user=${meta.userId}`);

    const refundAmount = this.betManager.cancelWaiting(meta.userId, 'disconnect');
    if (refundAmount > 0) {
      this.creditPlayerById(meta.userId, refundAmount);
    }

    if (meta.roomId) {
      this.finishGame(meta.roomId, 'disconnect', { forfeitingUserId: meta.userId });
    }
  }

  updateGamesPlayed(userIds) {
    userIds.forEach((userId) => {
      const stats = this.ensureRanking(userId);
      stats.games += 1;
    });
  }

  ensureRanking(userId) {
    if (!this.ranking.has(userId)) {
      const player = this.players.get(userId);
      this.ranking.set(userId, {
        userId,
        nickname: player?.nickname ?? 'Player',
        wins: 0,
        games: 0,
        creditsEarned: 0,
      });
    }
    const player = this.players.get(userId);
    const stats = this.ranking.get(userId);
    if (player) {
      stats.nickname = player.nickname;
    }
    return stats;
  }

  broadcastRoom(roomId, event, payload) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    this.io.to(roomId).emit(event, payload);
  }

  getRanking() {
    return Array.from(this.ranking.values()).sort((a, b) => {
      if (b.wins === a.wins) {
        return b.creditsEarned - a.creditsEarned;
      }
      return b.wins - a.wins;
    });
  }

  getResults() {
    return this.results;
  }

  getBetTransactions(limit = 25) {
    return this.betManager.getTransactions(limit);
  }
}
