import { randomUUID } from 'crypto';

const DEFAULT_HOUSE_PERCENTAGE = 0.1;
const LOG_LIMIT = 200;

export default class BetManager {
  constructor(options = {}) {
    this.houseCutPercentage = options.houseCutPercentage ?? DEFAULT_HOUSE_PERCENTAGE;
    this.pending = [];
    this.escrows = new Map(); // userId -> { amount, status, lockedAt }
    this.matches = new Map(); // roomId -> bet summary
    this.transactions = [];
  }

  hasEscrow(userId) {
    return this.escrows.has(userId);
  }

  queuePlayer(userId, amount) {
    if (this.escrows.has(userId)) {
      throw new Error('El jugador ya tiene créditos bloqueados');
    }

    const now = Date.now();
    const opponentIndex = this.pending.findIndex(
      (entry) => entry.amount === amount && entry.userId !== userId,
    );

    const escrow = { amount, status: 'waiting', lockedAt: now };
    this.escrows.set(userId, escrow);
    this.log('lock', { userId, amount, note: 'offer' });

    if (opponentIndex >= 0) {
      const opponent = this.pending.splice(opponentIndex, 1)[0];
      escrow.status = 'matched';
      const opponentEscrow = this.escrows.get(opponent.userId);
      if (opponentEscrow) {
        opponentEscrow.status = 'matched';
      }
      return { matched: true, opponentId: opponent.userId, amount };
    }

    this.pending.push({ userId, amount, createdAt: now });
    return { matched: false, amount };
  }

  cancelWaiting(userId, reason = 'cancelled') {
    const index = this.pending.findIndex((entry) => entry.userId === userId);
    if (index >= 0) {
      this.pending.splice(index, 1);
    }
    return this.unlockUser(userId, reason);
  }

  attachRoom(roomId, amount, playerIds) {
    const pot = amount * playerIds.length;
    const houseFee = pot * this.houseCutPercentage;
    const bet = {
      roomId,
      amountPerPlayer: amount,
      pot,
      houseFee,
      housePercentage: this.houseCutPercentage,
      createdAt: Date.now(),
      players: [...playerIds],
    };
    this.matches.set(roomId, bet);
    playerIds.forEach((userId) => {
      const escrow = this.escrows.get(userId);
      if (escrow) {
        escrow.status = 'in-room';
        escrow.roomId = roomId;
      }
    });
    return bet;
  }

  settle(roomId, winnerId) {
    const bet = this.matches.get(roomId);
    if (!bet) {
      return null;
    }

    this.matches.delete(roomId);
    const payouts = [];

    if (winnerId) {
      const netPrize = bet.pot - bet.houseFee;
      payouts.push({ userId: winnerId, amount: netPrize });
      this.log('payout', { userId: winnerId, amount: netPrize, roomId });
      if (bet.houseFee > 0) {
        this.log('house', { amount: bet.houseFee, roomId });
      }
    } else {
      bet.players.forEach((userId) => {
        payouts.push({ userId, amount: bet.amountPerPlayer });
        this.log('refund', { userId, amount: bet.amountPerPlayer, roomId, note: 'tie' });
      });
    }

    bet.players.forEach((userId) => this.escrows.delete(userId));
    return { payouts, houseFee: winnerId ? bet.houseFee : 0, bet };
  }

  refundRoom(roomId, reason = 'cancelled') {
    const bet = this.matches.get(roomId);
    if (!bet) {
      return [];
    }
    this.matches.delete(roomId);
    return bet.players.map((userId) => {
      this.log('refund', { userId, amount: bet.amountPerPlayer, roomId, note: reason });
      this.escrows.delete(userId);
      return { userId, amount: bet.amountPerPlayer };
    });
  }

  releasePlayers(userIds, reason = 'unlock') {
    return userIds.map((userId) => ({ userId, amount: this.unlockUser(userId, reason) }));
  }

  unlockUser(userId, reason = 'unlock') {
    const escrow = this.escrows.get(userId);
    if (!escrow) {
      return 0;
    }
    this.escrows.delete(userId);
    this.log('refund', { userId, amount: escrow.amount, note: reason });
    return escrow.amount;
  }

  log(type, payload) {
    const entry = {
      id: randomUUID(),
      ts: Date.now(),
      type,
      ...payload,
    };
    this.transactions.push(entry);
    if (this.transactions.length > LOG_LIMIT) {
      this.transactions.shift();
    }
  }

  getTransactions(limit = 25) {
    return this.transactions.slice(-limit).reverse();
  }
}
