'use strict';

/**
 * watcher.js — Monitoreo en tiempo real de conversaciones via SQLite.
 * Lee la DB del bot cada 5s y analiza nuevos mensajes del bot con Claude (call rápida, sin tools).
 */

const fs = require('fs');
const { anthropic, INSTRUCCIONES_PATH, MENU_PATH, NO_DISP_PATH, mensajesDb } = require('./config');

// ── SYSTEM PROMPT PARA ANÁLISIS RÁPIDO ────────────────────────────────────────
let _quickSystemCache  = null;
let _quickSystemMtime  = 0;

function buildQuickSystem() {
  let instrucciones = '';
  let menu          = '';
  let noDisp        = '';
  try {
    const mtime = fs.statSync(INSTRUCCIONES_PATH).mtimeMs;
    if (mtime !== _quickSystemMtime) {
      _quickSystemCache = null;
      _quickSystemMtime = mtime;
    }
    instrucciones = fs.readFileSync(INSTRUCCIONES_PATH, 'utf8');
  } catch (e) {}
  try { menu    = fs.readFileSync(MENU_PATH,    'utf8'); } catch (e) {}
  try { noDisp  = fs.readFileSync(NO_DISP_PATH, 'utf8').trim(); } catch (e) {}

  const menuLineas = menu.split('\n').slice(0, 120).join('\n');
  return `Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.
Recibirás el historial reciente de una conversación y los mensajes nuevos a evaluar.
Tu trabajo: detectar errores REALES y CONCRETOS del bot. Sé preciso, no reportes falsos positivos.

════════════════════════════════════════════
INSTRUCCIONES COMPLETAS DEL BOT:
════════════════════════════════════════════
${instrucciones}

════════════════════════════════════════════
MENÚ VIGENTE (CSV):
════════════════════════════════════════════
${menuLineas}
${noDisp ? `\n⛔ NO DISPONIBLES HOY:\n${noDisp}\n` : ''}
════════════════════════════════════════════
QUÉ DEBES DETECTAR:
════════════════════════════════════════════
1. Precio incorrecto
2. Ítem NO DISPONIBLE sugerido u ofrecido
3. Orden confirmada con ítems incorrectos
4. El bot mencionó el nombre del cliente (PROHIBIDO)
5. El bot ofreció facturación sin que el cliente la solicitara
6. Respuesta fuera de contexto del negocio
7. Datos de pago enviados sin ORDEN CONFIRMADA
8. El bot ignoró o contradijo reglas de las instrucciones
9. Tono grosero, condescendiente o inapropiado
10. Información falsa sobre horarios, pagos o políticas

Si todo está bien → responde SOLO la palabra: OK
Si hay problema → responde SOLO JSON puro:
{"problema":"...","severidad":"alta|media|baja","fragmento":"cita literal (máx 250 chars)","sugerencia":"...","regla_violada":"..."}`;
}

async function analizarIntercambioRapido(telefono, contextoCompleto, nuevasLineas) {
  try {
    const resp = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     buildQuickSystem(),
      messages:   [{
        role:    'user',
        content: `CLIENTE: ${telefono}\n\n══ HISTORIAL RECIENTE ══\n${contextoCompleto}\n\n══ MENSAJES NUEVOS ══\n${nuevasLineas}`,
      }],
    });
    return resp.content[0].text.trim();
  } catch (e) {
    console.error(`❌ Error Claude [${telefono}]:`, e.message);
    return 'OK';
  }
}

/**
 * Crea el procesador de memoria con acceso al estado compartido.
 * @param {object} estado - { estadoConv, alertasHoy, fechaHoy, encolarAlerta, guardarEstadoConv }
 */
function crearProcesadorMemoria(memDb, estado) {
  return async function procesarMemoria() {
    const hoy = new Date().toDateString();
    if (hoy !== estado.fechaHoy) { estado.alertasHoy = 0; estado.fechaHoy = hoy; }

    let rows = [];
    try { rows = memDb.getAllConversaciones(); } catch (e) { return; }

    let cambios = false;
    for (const row of rows) {
      const telefono     = row.mem_key;
      const conversacion = row.historial || '';
      if (!conversacion || typeof conversacion !== 'string') continue;

      const ultimaLong = estado.estadoConv[telefono] || 0;
      if (conversacion.length <= ultimaLong) continue;

      const nuevaParte = conversacion.slice(ultimaLong);
      estado.estadoConv[telefono] = conversacion.length;
      cambios = true;

      if (!nuevaParte.includes('Bot:')) continue;

      const inicioContexto    = Math.max(0, ultimaLong - 3000);
      const contextoAnterior  = conversacion.slice(inicioContexto, ultimaLong).trim();
      let nuevasLineas        = nuevaParte.trim();
      if (nuevasLineas.length > 6000) nuevasLineas = '...' + nuevasLineas.slice(-6000);

      console.log(`🔍 Analizando ${telefono} (+${nuevaParte.length} chars)...`);
      const resultado = await analizarIntercambioRapido(telefono, contextoAnterior, nuevasLineas);

      if (resultado === 'OK') { console.log(`  ✅ OK`); continue; }

      let problema;
      try {
        const jsonLimpio = resultado.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        problema = JSON.parse(jsonLimpio);
      } catch (e) {
        console.warn(`  ⚠️ Respuesta no-JSON descartada para ${telefono}`);
        continue;
      }

      console.log(`  ⚠️ [${problema.severidad}] ${problema.problema}`);
      estado.alertasHoy++;
      estado.encolarAlerta(telefono, problema, nuevasLineas);
    }
    if (cambios) estado.guardarEstadoConv(estado.estadoConv);
  };
}

module.exports = { crearProcesadorMemoria };
