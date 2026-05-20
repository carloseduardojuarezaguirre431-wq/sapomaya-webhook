#!/usr/bin/env node
/**
 * Ejecuta este script UNA SOLA VEZ después de desplegar tu servidor
 * para registrar los webhooks en Telegram.
 *
 * Uso:
 *   node registrar-webhooks.js https://TU-DOMINIO.com
 */

const TOKEN_RETIROS  = '8668269684:AAHES_9m1QGAXEkAg8KR1TfTLKwgKMiien0';
const TOKEN_RECARGAS = '8674509022:AAG7WO6PUThf6ddFpZiXQW4sHOL3QQRkMBs';

const BASE_URL = process.argv[2];

if (!BASE_URL) {
  console.error('❌ Debes pasar la URL base como argumento:\n   node registrar-webhooks.js https://tu-servidor.com');
  process.exit(1);
}

async function setWebhook(token, path, nombre) {
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${BASE_URL}${path}` }),
  });
  const json = await res.json();
  if (json.ok) {
    console.log(`✅ Webhook registrado para ${nombre}: ${BASE_URL}${path}`);
  } else {
    console.error(`❌ Error en ${nombre}:`, json);
  }
}

(async () => {
  await setWebhook(TOKEN_RECARGAS, '/webhook/recargas', 'RECARGAS SAPOMAYA');
  await setWebhook(TOKEN_RETIROS,  '/webhook/retiros',  'RETIROS SAPOMAYA');
  console.log('\n🐸 ¡Webhooks listos! Los botones de Telegram ya funcionarán.');
})();
