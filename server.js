const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ── Firebase Admin Init ──────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();

// ── Tokens de los bots ───────────────────────────────────────────
const TOKEN_RETIROS  = '8668269684:AAHES_9m1QGAXEkAg8KR1TfTLKwgKMiien0';
const TOKEN_RECARGAS = '8674509022:AAG7WO6PUThf6ddFpZiXQW4sHOL3QQRkMBs';
const CHAT_ID        = '6837082259';

// ── Helper: responder callback de Telegram ──────────────────────
async function answerCallback(token, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: true }),
  });
}

// ── Helper: enviar mensaje de Telegram ──────────────────────────
async function sendMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ── Helper: editar mensaje (quitar botones) ──────────────────────
async function editMessageReplyMarkup(token, chatId, messageId) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
}

// ── Helper: agregar historial al usuario ────────────────────────
async function agregarHistorial(uid, tipo, monto, extra = {}) {
  await db.collection('usuarios').doc(uid).collection('historial').add({
    tipo,
    monto,
    fecha: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  });
}

// ════════════════════════════════════════════════════════════════
// WEBHOOK — BOT DE RECARGAS
// ════════════════════════════════════════════════════════════════
app.post('/webhook/recargas', async (req, res) => {
  res.sendStatus(200); // responder rápido a Telegram

  const body = req.body;
  if (!body.callback_query) return;

  const cq       = body.callback_query;
  const data     = cq.data;           // "recarga_aprobar:ID" | "recarga_rechazar:ID"
  const msgId    = cq.message.message_id;
  const [action, docId] = data.split(':');

  if (!['recarga_aprobar', 'recarga_rechazar'].includes(action)) return;

  try {
    const recargaRef  = db.collection('recargas_pendientes').doc(docId);
    const recargaSnap = await recargaRef.get();

    if (!recargaSnap.exists) {
      await answerCallback(TOKEN_RECARGAS, cq.id, '❌ Solicitud no encontrada');
      return;
    }

    const recarga = recargaSnap.data();

    if (recarga.estado !== 'pendiente') {
      await answerCallback(TOKEN_RECARGAS, cq.id, '⚠️ Esta solicitud ya fue procesada');
      return;
    }

    if (action === 'recarga_aprobar') {
      // 1. Sumar saldo al usuario
      const usuarioRef  = db.collection('usuarios').doc(recarga.uid);
      const usuarioSnap = await usuarioRef.get();

      if (!usuarioSnap.exists) {
        await answerCallback(TOKEN_RECARGAS, cq.id, '❌ Usuario no encontrado en la base de datos');
        return;
      }

      const saldoActual = usuarioSnap.data().saldo || 0;
      const nuevoSaldo  = parseFloat((saldoActual + recarga.monto).toFixed(2));

      await usuarioRef.update({ saldo: nuevoSaldo });

      // 2. Actualizar historial: cambiar recarga_pendiente → recarga
      const histSnap = await db
        .collection('usuarios').doc(recarga.uid)
        .collection('historial')
        .where('tipo', '==', 'recarga_pendiente')
        .where('monto', '==', recarga.monto)
        .orderBy('fecha', 'desc')
        .limit(1)
        .get();

      if (!histSnap.empty) {
        await histSnap.docs[0].ref.update({ tipo: 'recarga' });
      } else {
        // Si no existe, crear uno nuevo aprobado
        await agregarHistorial(recarga.uid, 'recarga', recarga.monto);
      }

      // 3. Marcar recarga como aprobada
      await recargaRef.update({ estado: 'aprobada' });

      // 4. Responder en Telegram
      await answerCallback(TOKEN_RECARGAS, cq.id, `✅ Recarga de $${recarga.monto.toFixed(2)} aprobada para ${recarga.usuario}`);
      await editMessageReplyMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `✅ RECARGA APROBADA\n👤 ${recarga.usuario}\n💰 +$${recarga.monto.toFixed(2)} MXN añadidos`);

    } else if (action === 'recarga_rechazar') {
      // 1. Actualizar historial: cambiar recarga_pendiente → recarga_rechazada
      const histSnap = await db
        .collection('usuarios').doc(recarga.uid)
        .collection('historial')
        .where('tipo', '==', 'recarga_pendiente')
        .where('monto', '==', recarga.monto)
        .orderBy('fecha', 'desc')
        .limit(1)
        .get();

      if (!histSnap.empty) {
        await histSnap.docs[0].ref.update({ tipo: 'recarga_rechazada' });
      } else {
        await agregarHistorial(recarga.uid, 'recarga_rechazada', recarga.monto);
      }

      // 2. Marcar como rechazada
      await recargaRef.update({ estado: 'rechazada' });

      // 3. Responder en Telegram
      await answerCallback(TOKEN_RECARGAS, cq.id, `❌ Recarga rechazada para ${recarga.usuario}`);
      await editMessageReplyMarkup(TOKEN_RECARGAS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RECARGAS, CHAT_ID,
        `❌ RECARGA RECHAZADA\n👤 ${recarga.usuario}\n💰 $${recarga.monto.toFixed(2)} MXN — Saldo NO añadido`);
    }

  } catch (err) {
    console.error('Error en webhook recargas:', err);
    await answerCallback(TOKEN_RECARGAS, cq.id, '❌ Error interno del servidor');
  }
});

// ════════════════════════════════════════════════════════════════
// WEBHOOK — BOT DE RETIROS
// ════════════════════════════════════════════════════════════════
app.post('/webhook/retiros', async (req, res) => {
  res.sendStatus(200);

  const body = req.body;
  if (!body.callback_query) return;

  const cq       = body.callback_query;
  const data     = cq.data;
  const msgId    = cq.message.message_id;
  const [action, docId] = data.split(':');

  if (!['retiro_aprobar', 'retiro_rechazar'].includes(action)) return;

  try {
    const retiroRef  = db.collection('retiros_pendientes').doc(docId);
    const retiroSnap = await retiroRef.get();

    if (!retiroSnap.exists) {
      await answerCallback(TOKEN_RETIROS, cq.id, '❌ Solicitud no encontrada');
      return;
    }

    const retiro = retiroSnap.data();

    if (retiro.estado !== 'pendiente') {
      await answerCallback(TOKEN_RETIROS, cq.id, '⚠️ Esta solicitud ya fue procesada');
      return;
    }

    if (action === 'retiro_aprobar') {
      // El saldo ya fue descontado cuando el usuario solicitó el retiro.
      // Solo marcamos como aprobado y avisamos.
      await retiroRef.update({ estado: 'aprobado' });

      await answerCallback(TOKEN_RETIROS, cq.id,
        `✅ Retiro aprobado para ${retiro.usuario} — $${retiro.recibe.toFixed(2)} MXN a pagar`);
      await editMessageReplyMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `✅ RETIRO APROBADO\n👤 ${retiro.usuario}\n🏦 Cuenta: ${retiro.cuenta}\n👤 Titular: ${retiro.nombre}\n💸 A pagar: $${retiro.recibe.toFixed(2)} MXN`);

    } else if (action === 'retiro_rechazar') {
      // 1. Devolver saldo al usuario
      const usuarioRef  = db.collection('usuarios').doc(retiro.uid);
      const usuarioSnap = await usuarioRef.get();

      if (!usuarioSnap.exists) {
        await answerCallback(TOKEN_RETIROS, cq.id, '❌ Usuario no encontrado');
        return;
      }

      const saldoActual = usuarioSnap.data().saldo || 0;
      const saldoDevuelto = parseFloat((saldoActual + retiro.monto).toFixed(2));

      await usuarioRef.update({ saldo: saldoDevuelto });

      // 2. Actualizar historial: retiro → retiro_rechazado (devolución)
      await agregarHistorial(retiro.uid, 'recarga', retiro.monto, { nota: 'Devolución por retiro rechazado' });

      // 3. Marcar como rechazado
      await retiroRef.update({ estado: 'rechazado' });

      await answerCallback(TOKEN_RETIROS, cq.id,
        `❌ Retiro rechazado — $${retiro.monto.toFixed(2)} MXN devueltos a ${retiro.usuario}`);
      await editMessageReplyMarkup(TOKEN_RETIROS, CHAT_ID, msgId);
      await sendMessage(TOKEN_RETIROS, CHAT_ID,
        `❌ RETIRO RECHAZADO\n👤 ${retiro.usuario}\n💰 $${retiro.monto.toFixed(2)} MXN devueltos a su saldo`);
    }

  } catch (err) {
    console.error('Error en webhook retiros:', err);
    await answerCallback(TOKEN_RETIROS, cq.id, '❌ Error interno del servidor');
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🐸 SAPOMAYA Webhook activo'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🐸 Servidor corriendo en puerto ${PORT}`));
