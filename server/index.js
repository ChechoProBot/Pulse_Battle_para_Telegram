import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import GameManager from './gameManager.js';
import { buildTelegramInitDataValidator } from './telegramAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
});

const verifyTelegramInitData = buildTelegramInitDataValidator(TELEGRAM_BOT_TOKEN);
if (!verifyTelegramInitData) {
  console.warn('[telegram] TELEGRAM_BOT_TOKEN no configurado. El WebApp usará modo inseguro.');
}

const gameManager = new GameManager(io, { verifyTelegramInitData });

app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../client')));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', players: gameManager.players.size });
});

app.get('/api/ranking', (_req, res) => {
  res.json({ ranking: gameManager.getRanking(), houseBalance: gameManager.houseBalance });
});

app.get('/api/results', (_req, res) => {
  res.json({ matches: gameManager.getResults() });
});

app.get('/api/bets/logs', (_req, res) => {
  res.json({ transactions: gameManager.getBetTransactions(50) });
});

app.post('/api/telegram/auth', (req, res) => {
  if (!verifyTelegramInitData) {
    res.status(503).json({ message: 'Telegram no configurado en el servidor' });
    return;
  }

  const { initData } = req.body ?? {};
  try {
    const payload = verifyTelegramInitData(initData);
    res.json({ user: payload.user, authDate: payload.auth_date });
  } catch (err) {
    res.status(401).json({ message: err.message });
  }
});

io.on('connection', (socket) => gameManager.handleConnection(socket));

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../client/index.html'));
});

httpServer.listen(PORT, () => {
  console.log(`Pulse Battle corriendo en http://localhost:${PORT}`);
});
