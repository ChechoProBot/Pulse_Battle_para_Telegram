import { createHmac } from 'crypto';

function buildDataCheckString(params) {
  const ordered = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') {
      continue;
    }
    ordered.push(`${key}=${value}`);
  }
  ordered.sort();
  return ordered.join('\n');
}

export function buildTelegramInitDataValidator(botToken, options = {}) {
  if (!botToken) {
    return null;
  }

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const maxAgeSeconds = options.maxAgeSeconds ?? 60 * 60 * 24; // 24h window

  return (initData) => {
    if (!initData) {
      throw new Error('Telegram initData requerido');
    }

    const params = new URLSearchParams(initData);
    const providedHash = params.get('hash');
    if (!providedHash) {
      throw new Error('Hash ausente en initData');
    }

    const dataCheckString = buildDataCheckString(params);
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computedHash !== providedHash) {
      throw new Error('Firma de Telegram inválida');
    }

    const userRaw = params.get('user');
    const authDate = Number(params.get('auth_date'));
    if (!userRaw) {
      throw new Error('Datos de usuario ausentes');
    }

    const user = JSON.parse(userRaw);
    if (!user?.id) {
      throw new Error('Usuario de Telegram inválido');
    }

    if (Number.isFinite(maxAgeSeconds) && authDate) {
      const age = Math.floor(Date.now() / 1000) - authDate;
      if (age > maxAgeSeconds) {
        throw new Error('initData expirado');
      }
    }

    return { user, auth_date: authDate }; // eslint-disable-line camelcase
  };
}
