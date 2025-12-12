import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL || 'https://your-webapp-host.example/pulse-battle';

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN no está definido. Configúralo antes de ejecutar npm run bot');
}

const bot = new TelegramBot(token, { polling: true });

const webAppButton = {
  text: 'Abrir Pulse Battle ⚡',
  web_app: { url: webAppUrl },
};

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 'Listo para batallar. Abre la WebApp y pulsa sin parar.', {
    reply_markup: {
      inline_keyboard: [[webAppButton]],
    },
  });
});

bot.on('message', (msg) => {
  if (msg?.web_app_data?.data) {
    console.log('[webapp:data]', msg.from?.id, msg.web_app_data.data);
  }
});

console.log('[bot] Escuchando comandos con polling. Usa Ctrl+C para detenerlo.');

// Para operar con webhook en lugar de polling:
// 1. Desactiva polling (elimina la opción { polling: true }).
// 2. Expone una URL HTTPS pública (por ejemplo, usando ngrok o un dominio propio).
// 3. Llama a bot.setWebHook('https://tu-dominio.com/bot<token>').
// 4. Atiende POST /bot<token> con los updates y pásalos a bot.processUpdate(body).
