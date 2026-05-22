const express = require('express');
const app = express();
app.use(express.json());

// ── Configuración ────────────────────────────────────────────────
const TOKEN_RETIROS  = '8668269684:AAHES_9m1QGAXEkAg8KR1TfTLKwgKMiien0';
const TOKEN_RECARGAS = '8674509022:AAG7WO6PUThf6ddFpZiXQW4sHOL3QQRkMBs';
const CHAT_ID        = '6837082259';

const FIREBASE_PROJECT = 'sapom-99355';
const FIREBASE_API_KEY = 'AIzaSyAv7_CG2OUGKaZyn7Ngt_-WcuawJn2ZLHs';
const DB_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// ── Firebase REST helpers ────────────────────────────────────────
async function getDoc(path) {
  const res = await fetch(`${DB_URL}/${path}?key=${FIREBASE_API_KEY}`);
  if (!res.ok) throw new Error(`getDoc failed: ${res.status}`);
  return res.json();
}

async function updateDoc(path, fields) {
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string')  body.fields[k] = { stringValue: v };
    if (typeof v === 'number')  body.fields[k] = { doubleValue: v };
  }
  const fieldPaths = Object.keys(fields).join(',');
  const res = await fetch(
    `${DB_URL}/${path}?key=${FIREBASE_API_KEY}&updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`updateDoc failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function addDoc(path, fields) {
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') body.fields[k] = { stringValue: v };
    if (typeof v === 'number') body.fields[k] = { doubleValue: v };
  }
  body.fields['fecha'] = { timestampValue: new Date().toISOString() };
  const res = await fetch(
    `${DB_URL}/${path}?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) throw new Error(`addDoc failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function queryDocs(path, field, op, value) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: path.split('/').pop() }],
      where: { fieldFilter: { field: { fieldPath: field }, op, value: { stringValue: value } } },
      orderBy: [{ field: { fieldPath: 'fecha' }, direction: 'DESCENDING' }],
      limit: 1
    }
  };
  const parentPath = path.split('/').slice(0, -1).join('/');
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, parent: `projects/${FIREBASE_PROJECT}/databases/(default)/documents/${parentPath}` }) }
  );
  if (!res.ok) throw new Error(`query failed: ${res.status}`);
  return res.json();
}

function getField(doc, field) {
  const f = doc.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.doubleValue ?? f.integerValue ?? f.booleanValue ?? null;
}

// ── Telegram helpers ─────────────────────────────────────────────
async function answerCallback(token, id, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id, text, show_alert: true })
  });
}

async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function editMarkup(token, chatId, msgId) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } })
  });
}

// ════════════════════════════════════════════════════════════════
// WEBHOOK RECARGAS
// ════════════════════════════════════════════════════════════════
app.post('/webhook/recargas', async (req, res) => {
  res.sendStatus(200);
  const cq = req.body?.callback_query;
  if (!cq) return;

  const [action, docId] = cq.data.split(':');
  const msgId = cq.message.message_id;
  if (!['recarga_aprobar', 'recarga_rechazar'].includes(action)) return;

  try {
    const snap    = await getDoc(`recargas_pendientes/${docId}`);
    const estado  = getField(snap, 'estado');
    const uid     = getField(snap, 'uid');
    const monto   = parseFloat(getField(snap, 'monto'));
    const usuario = getField(snap, 'usuario');

    if (estado !== 'pendiente') {
      await answerCallback(TOKEN_RECARGAS, cq.id, '⚠️ Ya fue procesada'); return;
    }

    if (action === 'recarga_aprobar') {
      // Obtener saldo actual
      const userSnap   = await getDoc(`usuarios/${uid}`);
      const saldoActual = parseFloat(getField(userSnap, 'saldo') || 0);
      const nuevoSaldo  = parseFloat((saldoActual + monto).toFixed(2));

      // Actualizar saldo
      await updateDoc(`usuarios/${uid}`, { saldo: nuevoSaldo });

      // Agregar historial
      await addDoc(`usuarios/${uid}/historial`, { tipo: 'recarga', monto });

      // Marcar aprobada
      await updateDoc(`recargas_pendientes/${docId}`, { estado: 'aprobada' });

      await answerCallback(TOKEN_RECARGAS, cq.id, `✅ Recarga aprobada — $${monto.toFixed(2)} añadidos`);
      await editMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `✅ RECARGA APROBADA\n👤 ${usuario}\n💰 +$${monto.toFixed(2)} MXN añadidos al saldo`);

    } else {
      await addDoc(`usuarios/${uid}/historial`, { tipo: 'recarga_rechazada', monto });
      await updateDoc(`recargas_pendientes/${docId}`, { estado: 'rechazada' });

      await answerCallback(TOKEN_RECARGAS, cq.id, `❌ Recarga rechazada`);
      await editMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `❌ RECARGA RECHAZADA\n👤 ${usuario}\n💰 $${monto.toFixed(2)} MXN — Saldo NO modificado`);
    }

  } catch (err) {
    console.error('Error webhook recargas:', err.message);
    await answerCallback(TOKEN_RECARGAS, cq.id, '❌ Error: ' + err.message);
  }
});

// ════════════════════════════════════════════════════════════════
// WEBHOOK RETIROS
// ════════════════════════════════════════════════════════════════
app.post('/webhook/retiros', async (req, res) => {
  res.sendStatus(200);
  const cq = req.body?.callback_query;
  if (!cq) return;

  const [action, docId] = cq.data.split(':');
  const msgId = cq.message.message_id;
  if (!['retiro_aprobar', 'retiro_rechazar'].includes(action)) return;

  try {
    const snap    = await getDoc(`retiros_pendientes/${docId}`);
    const estado  = getField(snap, 'estado');
    const uid     = getField(snap, 'uid');
    const monto   = parseFloat(getField(snap, 'monto'));
    const recibe  = parseFloat(getField(snap, 'recibe'));
    const usuario = getField(snap, 'usuario');
    const cuenta  = getField(snap, 'cuenta');
    const nombre  = getField(snap, 'nombre');

    if (estado !== 'pendiente') {
      await answerCallback(TOKEN_RETIROS, cq.id, '⚠️ Ya fue procesada'); return;
    }

    if (action === 'retiro_aprobar') {
      await updateDoc(`retiros_pendientes/${docId}`, { estado: 'aprobado' });

      await answerCallback(TOKEN_RETIROS, cq.id, `✅ Retiro aprobado — $${recibe.toFixed(2)} a pagar`);
      await editMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `✅ RETIRO APROBADO\n👤 ${usuario}\n🏦 Cuenta: ${cuenta}\n👤 Titular: ${nombre}\n💸 A pagar: $${recibe.toFixed(2)} MXN`);

    } else {
      // Devolver saldo
      const userSnap    = await getDoc(`usuarios/${uid}`);
      const saldoActual = parseFloat(getField(userSnap, 'saldo') || 0);
      const saldoNuevo  = parseFloat((saldoActual + monto).toFixed(2));

      await updateDoc(`usuarios/${uid}`, { saldo: saldoNuevo });
      await addDoc(`usuarios/${uid}/historial`, { tipo: 'recarga', monto, nota: 'Devolución retiro rechazado' });
      await updateDoc(`retiros_pendientes/${docId}`, { estado: 'rechazado' });

      await answerCallback(TOKEN_RETIROS, cq.id, `❌ Retiro rechazado — $${monto.toFixed(2)} devueltos`);
      await editMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `❌ RETIRO RECHAZADO\n👤 ${usuario}\n💰 $${monto.toFixed(2)} MXN devueltos a su saldo`);
    }

  } catch (err) {
    console.error('Error webhook retiros:', err.message);
    await answerCallback(TOKEN_RETIROS, cq.id, '❌ Error: ' + err.message);
  }
});

app.get('/', (req, res) => res.send('🐸 SAPOMAYA Webhook activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐸 Servidor corriendo en puerto ${PORT}`));
