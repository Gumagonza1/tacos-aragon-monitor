'use strict';

/**
 * log_watcher.js — Detecta nuevos errores en logs/error.log y lanza análisis agéntico.
 */

const fs = require('fs');
const { ERROR_LOG, mensajesDb } = require('./config');
const { runAgentLoop }          = require('./agente');

function crearLogWatcher({ encolarMensaje, executeTool }) {
  const estadoLogs = { errorLogSize: 0 };

  // Inicializar tamaño actual para no analizar el historial al arrancar
  try { estadoLogs.errorLogSize = fs.statSync(ERROR_LOG).size; } catch (e) {}

  async function procesarLogsError() {
    if (!fs.existsSync(ERROR_LOG)) return;
    try {
      const stat     = fs.statSync(ERROR_LOG);
      const tamActual = stat.size;
      if (tamActual <= estadoLogs.errorLogSize) return;

      const fd         = fs.openSync(ERROR_LOG, 'r');
      const nuevosBytes = tamActual - estadoLogs.errorLogSize;
      const buf        = Buffer.alloc(Math.min(nuevosBytes, 8000));
      const offset     = Math.max(0, tamActual - 8000);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      estadoLogs.errorLogSize = tamActual;

      const nuevoTexto = buf.toString('utf8').trim();
      if (!nuevoTexto) return;

      const lineasError = nuevoTexto.split('\n').filter(l =>
        /error|Error|ERROR|exception|Exception|TypeError|ReferenceError|❌|crash|FATAL|unhandled/i.test(l)
      );
      if (!lineasError.length) return;

      console.log(`🔴 Nuevos errores en logs (${lineasError.length} líneas) — analizando...`);

      const resumen = await runAgentLoop(
        `Eres el monitor de calidad del bot de Tacos Aragón. Se detectaron errores nuevos en los logs.
Analiza los errores, determina su causa raíz y propón una solución concreta.
Si el error es recurrente, usa buscar_en_conversaciones.
Si necesitas más contexto, usa ejecutar_shell (ej: tail -100 logs/error.log).
Si es un bug de código, usa proponer_cambio.
Respuesta final: resumen ejecutivo breve (máx 300 chars) para el admin.`,
        `ERRORES NUEVOS EN logs/error.log:\n${lineasError.slice(-50).join('\n')}`,
        executeTool
      );

      if (resumen) {
        encolarMensaje('log-error-' + Date.now(),
          `🔴 *ERRORES EN LOGS DETECTADOS*\n\n` +
          `📋 ${lineasError.length} líneas de error nuevas\n\n` +
          `🤖 *Análisis:*\n${resumen}`
        );
      }
    } catch (e) {
      console.error('❌ procesarLogsError:', e.message);
    }
  }

  function iniciarWatch(procesarLogsErrorFn) {
    let debounceLog = null;
    try {
      fs.watch(ERROR_LOG, (eventType) => {
        if (eventType !== 'change') return;
        if (debounceLog) clearTimeout(debounceLog);
        debounceLog = setTimeout(procesarLogsErrorFn, 4000);
      });
      console.log('   Watch error.log: activo');
    } catch (e) {
      console.warn('   Watch error.log falló, polling 2min:', e.message);
      setInterval(procesarLogsErrorFn, 120000);
    }
  }

  return { procesarLogsError, iniciarWatch };
}

module.exports = { crearLogWatcher };
