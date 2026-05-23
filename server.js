const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Lee la private key desde variable de entorno
let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
try {
  const parsed = JSON.parse(privateKey);
  if (parsed.key) privateKey = parsed.key;
} catch(e) {}
privateKey = privateKey.replace(/\\n/g, '\n');

console.log('🔑 Private key starts with:', privateKey.substring(0, 40));

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  privateKey,
  }),
});

const db = admin.firestore();

const TOKEN_RETIROS  = '8668269684:AAHES_9m1QGAXEkAg8KR1TfTLKwgKMiien0';
const TOKEN_RECARGAS = '8674509022:AAG7WO6PUThf6ddFpZiXQW4sHOL3QQRkMBs';
const CHAT_ID        = '6837082259';

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

async function agregarHistorial(uid, tipo, monto, extra = {}) {
  await db.collection('usuarios').doc(uid).collection('historial').add({
    tipo, monto, fecha: admin.firestore.FieldValue.serverTimestamp(), ...extra
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
    const recargaRef = db.collection('recargas_pendientes').doc(docId);

    // ── Transacción atómica — evita doble procesamiento ──────────
    const resultado = await db.runTransaction(async (t) => {
      const recargaSnap = await t.get(recargaRef);
      if (!recargaSnap.exists) return { ok: false, msg: '❌ Solicitud no encontrada' };
      const recarga = recargaSnap.data();
      if (recarga.estado !== 'pendiente') return { ok: false, msg: '⚠️ Ya fue procesada' };

      if (action === 'recarga_aprobar') {
        const userRef  = db.collection('usuarios').doc(recarga.uid);
        const userSnap = await t.get(userRef);
        if (!userSnap.exists) return { ok: false, msg: '❌ Usuario no encontrado' };
        const nuevoSaldo = parseFloat(((userSnap.data().saldo || 0) + recarga.monto).toFixed(2));
        t.update(userRef, { saldo: nuevoSaldo });
        t.update(recargaRef, { estado: 'aprobada' });
        return { ok: true, action: 'aprobada', recarga };
      } else {
        t.update(recargaRef, { estado: 'rechazada' });
        return { ok: true, action: 'rechazada', recarga };
      }
    });

    if (!resultado.ok) {
      await answerCallback(TOKEN_RECARGAS, cq.id, resultado.msg);
      return;
    }

    const { recarga } = resultado;

    if (resultado.action === 'aprobada') {
      await agregarHistorial(recarga.uid, 'recarga', recarga.monto);
      await answerCallback(TOKEN_RECARGAS, cq.id, `✅ Recarga aprobada — $${recarga.monto.toFixed(2)} añadidos`);
      await editMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `✅ RECARGA APROBADA\n👤 ${recarga.usuario}\n💰 +$${recarga.monto.toFixed(2)} MXN añadidos al saldo`);
    } else {
      await agregarHistorial(recarga.uid, 'recarga_rechazada', recarga.monto);
      await answerCallback(TOKEN_RECARGAS, cq.id, `❌ Recarga rechazada`);
      await editMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `❌ RECARGA RECHAZADA\n👤 ${recarga.usuario}\n💰 $${recarga.monto.toFixed(2)} MXN — Saldo NO modificado`);
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
    const retiroRef = db.collection('retiros_pendientes').doc(docId);

    // ── Transacción atómica — evita doble procesamiento ──────────
    const resultado = await db.runTransaction(async (t) => {
      const retiroSnap = await t.get(retiroRef);
      if (!retiroSnap.exists) return { ok: false, msg: '❌ Solicitud no encontrada' };
      const retiro = retiroSnap.data();
      if (retiro.estado !== 'pendiente') return { ok: false, msg: '⚠️ Ya fue procesada' };

      if (action === 'retiro_aprobar') {
        t.update(retiroRef, { estado: 'aprobado' });
        return { ok: true, action: 'aprobado', retiro };
      } else {
        const userRef  = db.collection('usuarios').doc(retiro.uid);
        const userSnap = await t.get(userRef);
        if (!userSnap.exists) return { ok: false, msg: '❌ Usuario no encontrado' };
        const saldoNuevo = parseFloat(((userSnap.data().saldo || 0) + retiro.monto).toFixed(2));
        t.update(userRef, { saldo: saldoNuevo });
        t.update(retiroRef, { estado: 'rechazado' });
        return { ok: true, action: 'rechazado', retiro };
      }
    });

    if (!resultado.ok) {
      await answerCallback(TOKEN_RETIROS, cq.id, resultado.msg);
      return;
    }

    const { retiro } = resultado;

    if (resultado.action === 'aprobado') {
      await answerCallback(TOKEN_RETIROS, cq.id, `✅ Retiro aprobado — $${retiro.recibe.toFixed(2)} a pagar`);
      await editMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `✅ RETIRO APROBADO\n👤 ${retiro.usuario}\n🏦 Cuenta: ${retiro.cuenta}\n👤 Titular: ${retiro.nombre}\n💸 A pagar: $${retiro.recibe.toFixed(2)} MXN`);
    } else {
      await agregarHistorial(retiro.uid, 'recarga', retiro.monto, { nota: 'Devolución retiro rechazado' });
      await answerCallback(TOKEN_RETIROS, cq.id, `❌ Retiro rechazado — $${retiro.monto.toFixed(2)} devueltos`);
      await editMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `❌ RETIRO RECHAZADO\n👤 ${retiro.usuario}\n💰 $${retiro.monto.toFixed(2)} MXN devueltos a su saldo`);
    }

  } catch (err) {
    console.error('Error webhook retiros:', err.message);
    await answerCallback(TOKEN_RETIROS, cq.id, '❌ Error: ' + err.message);
  }
});

app.get('/', (req, res) => res.send('🐸 SAPOMAYA Webhook activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐸 Servidor corriendo en puerto ${PORT}`));
