'use strict';

/**
 * pm2_watcher.js — Detecta reinicios de TacosAragon y verifica conexión WhatsApp post-reinicio.
 */

const { execSync } = require('child_process');
const { BASE }     = require('./config');
const { runAgentLoop } = require('./agente');

function crearPm2Watcher({ encolarMensaje, executeTool }) {
  let tacosRestartCount = -1; // -1 = no inicializado

  async function verificarConexionWhatsApp(restartNum) {
    console.log(`🔍 Verificando conexión WhatsApp post-reinicio #${restartNum}...`);
    try {
      const resumen = await runAgentLoop(
        `Eres el monitor del bot de Tacos Aragón. El proceso TacosAragon acaba de reiniciarse.
Verifica si WhatsApp se conectó correctamente:
1. ejecutar_shell("pm2 status")
2. ejecutar_shell("pm2 logs TacosAragon --lines 60 --nostream")
3. Busca "✅ SISTEMA ACTIVO" como señal de éxito, y errores como "Chrome", "Session", "Auth", "❌", "timeout"
4. Si NO se conectó: ejecutar_shell("tail -50 logs/error.log") y diagnostica
Responde en máx 300 chars: "✅ Bot conectado [detalles]" o "❌ Bot NO conectado — [diagnóstico y pasos]"`,
        `Verificar arranque de TacosAragon reinicio #${restartNum}`,
        executeTool
      );

      const exito = resumen && /SISTEMA ACTIVO|conectado|ready|✅/i.test(resumen);
      const emoji = exito ? '✅' : '🔴';
      encolarMensaje(`verificacion-${restartNum}`,
        `${emoji} *Verificación post-reinicio #${restartNum}*\n\n${resumen || 'No se pudo obtener resultado.'}`
      );
      console.log(`  ${emoji} Verificación #${restartNum}: ${(resumen || '').slice(0, 80)}`);
    } catch (e) {
      console.error('❌ verificarConexionWhatsApp:', e.message);
      encolarMensaje(`verificacion-err-${restartNum}`, `❌ *Error al verificar arranque #${restartNum}:*\n${e.message}`);
    }
  }

  async function checkTacosAragonRestarts() {
    try {
      const salidaJson = execSync('pm2 jlist', {
        cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true,
      });
      const procs = JSON.parse(salidaJson);
      const tacos = procs.find(p => p.name === 'TacosAragon');
      if (!tacos) return;

      const restarts = tacos.pm2_env.restart_time || 0;
      if (tacosRestartCount === -1) {
        tacosRestartCount = restarts;
        console.log(`   TacosAragon restarts base: ${restarts}`);
        return;
      }

      if (restarts > tacosRestartCount) {
        console.log(`🔄 TacosAragon reiniciado (restart #${restarts}) — verificando en 90s...`);
        tacosRestartCount = restarts;
        setTimeout(() => verificarConexionWhatsApp(restarts).catch(console.error), 90000);
      }
    } catch (e) {
      // pm2 jlist puede fallar si PM2 no está disponible — ignorar
    }
  }

  async function revisionPeriodica() {
    try {
      const salidaJson = execSync('pm2 jlist', {
        cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true,
      });
      const procs = JSON.parse(salidaJson);
      const tacos = procs.find(p => p.name === 'TacosAragon');
      if (!tacos) {
        encolarMensaje('salud-' + Date.now(), '🔴 *ALERTA:* TacosAragon no aparece en PM2.');
        return;
      }

      const estado     = tacos.pm2_env.status;
      const uptime     = tacos.pm2_env.pm_uptime;
      const uptimeMin  = uptime ? Math.floor((Date.now() - uptime) / 60000) : 0;

      let ultimasLineas = '';
      try {
        ultimasLineas = execSync('pm2 logs TacosAragon --lines 80 --nostream', {
          cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true,
        });
      } catch (e) { ultimasLineas = ''; }

      const sistemaActivo = ultimasLineas.includes('SISTEMA ACTIVO');
      const hayActividad  = /Bot:|Cliente:|Loyverse|ORDEN CONFIRMADA/i.test(ultimasLineas);
      const hayErrores    = /❌|Error|timeout|desconectado/i.test(ultimasLineas);

      let icono, mensaje;
      if (estado !== 'online') {
        icono   = '🔴';
        mensaje = `TacosAragon en estado: *${estado}*. Revisar urgente.`;
      } else if (!sistemaActivo && uptimeMin < 60) {
        icono   = '🟡';
        mensaje = `Proceso online pero sin señal "SISTEMA ACTIVO" en logs (${uptimeMin} min activo).`;
      } else if (hayErrores && !hayActividad) {
        icono   = '🟡';
        mensaje = `Proceso online pero con errores recientes y sin actividad de clientes.`;
      } else {
        icono   = '✅';
        mensaje = `TacosAragon OK | uptime: ${uptimeMin} min | ${hayActividad ? 'con actividad reciente' : 'sin mensajes recientes'}`;
      }

      console.log(`⏱️ Revisión 30min: ${icono} ${mensaje}`);
      if (icono !== '✅') {
        encolarMensaje('salud-' + Date.now(), `${icono} *Revisión periódica TacosAragon*\n\n${mensaje}`);
      }
    } catch (e) {
      console.error('❌ Revisión periódica:', e.message);
    }
  }

  return { checkTacosAragonRestarts, revisionPeriodica };
}

module.exports = { crearPm2Watcher };
