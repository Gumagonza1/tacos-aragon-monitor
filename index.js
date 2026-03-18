'use strict';

/**
 * index.js — Punto de entrada del Agente Monitor de Calidad.
 * Ensambla todos los módulos y arranca los intervalos de polling.
 */

const { mensajesDb, memDb } = require('./src/config');
const estadoDB              = require('./src/estado_db');
const { TOOLS, crearExecuteTool } = require('./src/herramientas');
const { runAgentLoop }            = require('./src/agente');
const { crearProcesadorMemoria }  = require('./src/watcher');
const { crearGestorAlertas }      = require('./src/alertas');
const { crearProcesadorComandos, SYSTEM_PROFUNDO } = require('./src/comandos');
const { crearPm2Watcher }         = require('./src/pm2_watcher');
const { crearLogWatcher }         = require('./src/log_watcher');

// ── ESTADO COMPARTIDO (cargado desde SQLite) ─────────────────────────────────
const estadoConv = estadoDB.cargarEstadoConv();
let   pendientes = estadoDB.cargarPendientes();

let alertaCounter    = 0;
let propuestaCounter = 0;
let alertasHoy       = 0;
let fechaHoy         = new Date().toDateString();

// ── HELPERS DE ESTADO ────────────────────────────────────────────────────────
function encolarMensaje(id, mensaje) {
  mensajesDb.encolarMensaje(id, mensaje, 'monitor');
}
function encolarMedia(id, tipo, filePath, caption) {
  mensajesDb.encolarMedia(id, tipo, filePath, caption, 'monitor');
}

// ── WIRING — crear módulos con dependencias inyectadas ────────────────────────

const estadoCompartido = {
  estadoConv,
  alertasHoy,
  fechaHoy,
  get alertasHoy()  { return alertasHoy; },
  set alertasHoy(v) { alertasHoy = v; },
  get fechaHoy()    { return fechaHoy; },
  set fechaHoy(v)   { fechaHoy = v; },
  guardarEstadoConv: (e) => estadoDB.guardarEstadoConv(e),
};

// Gestor de alertas (necesita el encolarAlerta para el watcher)
const gestorAlertas = crearGestorAlertas({
  encolarMensaje,
  getPendientes:     () => pendientes,
  addPendiente:      (p) => { pendientes.push(p); estadoDB.guardarPendientes(pendientes); },
  getAlertaCounter:  () => alertaCounter,
  incAlertaCounter:  () => alertaCounter++,
});
estadoCompartido.encolarAlerta = gestorAlertas.encolarAlerta;

// executeTool con acceso al estado
const executeTool = crearExecuteTool({
  getPropuestaCounter:  () => propuestaCounter,
  incPropuestaCounter:  () => propuestaCounter++,
  getPendientes:        () => pendientes,
  addPendiente:         (p) => { pendientes.push(p); estadoDB.guardarPendientes(pendientes); },
  encolarMensaje,
  encolarMedia,
});

// Análisis profundo (usado por comandos y nocturno)
async function realizarAnalisisProfundo(contextoExtra = '') {
  console.log('🔬 Iniciando análisis profundo...');
  encolarMensaje('analisis-inicio', '🔬 *Monitor:* Iniciando análisis profundo... ⏳');
  try {
    const msg = contextoExtra ||
      'Realiza el análisis completo: intervenciones humanas, conversaciones problemáticas y propón mejoras.';
    const resultado = await runAgentLoop(SYSTEM_PROFUNDO, msg, executeTool);
    if (resultado) {
      encolarMensaje('analisis-fin', `🔬 *ANÁLISIS COMPLETADO*\n\n${resultado}`);
    }
  } catch (e) {
    console.error('❌ Error análisis profundo:', e.message);
    encolarMensaje('analisis-error', `❌ Error en análisis profundo: ${e.message}`);
  }
}

// Procesador de comandos del admin
const { procesarComandoAdmin, procesarRespuestas } = crearProcesadorComandos({
  encolarMensaje,
  getPendientes:        () => pendientes,
  setPendientes:        (arr) => { pendientes = arr; },
  guardarPendientes:    (arr) => estadoDB.guardarPendientes(arr),
  aplicarSugerenciaAlerta: gestorAlertas.aplicarSugerenciaAlerta,
  aplicarPropuesta:     gestorAlertas.aplicarPropuesta,
  realizarAnalisisProfundo,
  executeTool,
  memDb,
  estado:               { alertasHoy: 0, get alertasHoy() { return alertasHoy; } },
});

// Watcher de conversaciones SQLite
const procesarMemoria = crearProcesadorMemoria(memDb, estadoCompartido);

// PM2 watcher (detección de reinicios + verificación WhatsApp)
const { checkTacosAragonRestarts, revisionPeriodica } = crearPm2Watcher({ encolarMensaje, executeTool });

// Log watcher (análisis de errores nuevos en logs)
const logWatcher = crearLogWatcher({ encolarMensaje, executeTool });

// ── INICIO ───────────────────────────────────────────────────────────────────
console.log('🤖 Agente Monitor iniciado');
console.log(`   Modelo: claude-sonnet-4-6 (tool use habilitado)`);
console.log(`   Estado previo: ${Object.keys(estadoConv).length} conversaciones`);
console.log(`   Pendientes cargados: ${pendientes.length}`);
console.log(`   Tools disponibles: ${TOOLS.map(t => t.name).join(', ')}`);

// Polling conversaciones cada 5s
setInterval(procesarMemoria, 5000);
console.log('   Watch conversaciones: polling SQLite cada 5s');

// Watch error.log con debounce
logWatcher.iniciarWatch(logWatcher.procesarLogsError);

// Poll de respuestas del admin cada 5s
setInterval(procesarRespuestas, 5000);

// Verificación de reinicios de TacosAragon cada 30s
setTimeout(checkTacosAragonRestarts, 8000);
setInterval(checkTacosAragonRestarts, 30000);

// Revisión periódica del estado cada 30 minutos
setInterval(revisionPeriodica, 30 * 60 * 1000);

// Análisis inicial al arrancar
setTimeout(procesarMemoria, 6000);

// Análisis profundo nocturno automático — 2:00 AM hora Hermosillo
setInterval(() => {
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Hermosillo' })).getHours();
  if (hora === 2) {
    if (!realizarAnalisisProfundo._hoyEjecutado) {
      realizarAnalisisProfundo._hoyEjecutado = true;
      realizarAnalisisProfundo('Análisis nocturno automático. Revisa todo lo del día y propón mejoras.').catch(console.error);
    }
  } else {
    realizarAnalisisProfundo._hoyEjecutado = false;
  }
}, 60 * 60 * 1000);

// Limpieza de cola cada hora
setInterval(() => {
  try {
    mensajesDb.limpiarQueueViejos();
    console.log('🧹 Cola limpiada');
  } catch (e) {
    console.error('[monitor] Error en limpieza de cola:', e.message);
  }
}, 3600000);

process.on('SIGINT',  () => { estadoDB.guardarEstadoConv(estadoConv); process.exit(0); });
process.on('SIGTERM', () => { estadoDB.guardarEstadoConv(estadoConv); process.exit(0); });
process.on('uncaughtException',  (err) => console.error('💀 Monitor error:', err.message));
process.on('unhandledRejection', (r)   => console.error('💀 Monitor rejection:', r));
