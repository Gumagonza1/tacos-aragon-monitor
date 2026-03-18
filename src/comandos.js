'use strict';

/**
 * comandos.js — Procesa comandos del admin (!m si / !m no / !m reporte / !m estado)
 * y respuestas a alertas/propuestas pendientes.
 */

const fs           = require('fs');
const { execSync } = require('child_process');
const { anthropic, BASE, INTERV_PATH, mensajesDb } = require('./config');
const { runAgentLoop }                              = require('./agente');

// System prompt de análisis profundo
const SYSTEM_PROFUNDO = `Eres el agente de control de calidad y mejora continua del bot de WhatsApp de Tacos Aragón.
Tienes acceso completo a todas las herramientas del sistema.

TU PROCESO COMPLETO:
1. ejecutar_shell("tail -200 logs/error.log")
2. ejecutar_shell("tail -150 logs/output.log")
3. leer_intervenciones (¿qué causó que el admin tomara control?)
4. listar_conversaciones — identifica las más largas o problemáticas
5. leer_conversacion para conversaciones sospechosas
6. buscar_en_conversaciones si detectas un patrón recurrente
7. ejecutar_shell("grep -n 'Error|❌' logs/error.log | tail -30") para errores de código
8. leer_archivo para entender la causa raíz
9. proponer_cambio si tienes evidencia suficiente

REGLAS:
- Siempre empieza por los logs
- Solo propón cambios con evidencia concreta
- Prioriza: errores de sistema > intervenciones humanas > confusiones repetidas > mejoras

Al terminar: resumen ejecutivo (máx 500 chars).`;

// System prompt para conversación libre con el admin
const SYSTEM_CONV_LIBRE = `Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.
El administrador te habla directamente. Responde en español, conciso y útil.
Negocio: martes–domingo, 6 PM–11:30 PM, GMT-7. Cierra los lunes.

## Ventas → consultar_api
  /api/ventas/resumen?periodo=hoy|ayer|semana|mes → total, pedidos, ticketPromedio, porPago, porCanal, topProductos
  /api/ventas/empleados-ventas?periodo=... | /api/ventas/por-producto?nombre=X&periodo=...
  /api/ventas/grafica?periodo=...&agrupar=hora|dia | /api/dashboard | /api/ventas/cierres?periodo=...

## Gráficas/Audio → enviar_media
## Estado/Logs → ejecutar_shell(pm2 status / pm2 logs / grep logs)
## Conversaciones → leer_conversacion / listar_conversaciones / buscar_en_conversaciones
## Código → leer_archivo / proponer_cambio

⛔ NUNCA uses ejecutar_shell para buscar ventas.`;

function crearProcesadorComandos({
  encolarMensaje, getPendientes, setPendientes, guardarPendientes,
  aplicarSugerenciaAlerta, aplicarPropuesta, realizarAnalisisProfundo,
  executeTool, memDb, estado,
}) {
  const convLibreHistorial = []; // historial de sesión en memoria

  async function procesarConversacionLibre(convId, texto) {
    console.log(`💬 Conversación libre: "${texto.slice(0, 80)}"`);
    try {
      convLibreHistorial.push({ role: 'user', content: texto });
      if (convLibreHistorial.length > 40) convLibreHistorial.splice(0, 2);

      const messages = [...convLibreHistorial];
      const { TOOLS } = require('./herramientas');
      let iter = 0;

      while (iter++ < 10) {
        const response = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 2048,
          system:     SYSTEM_CONV_LIBRE,
          tools:      TOOLS,
          messages,
        });

        if (response.stop_reason === 'end_turn') {
          const respuesta = response.content.find(c => c.type === 'text')?.text || '';
          convLibreHistorial.push({ role: 'assistant', content: respuesta });
          encolarMensaje(`conv-resp-${convId}`, `🤖 *Monitor*\n\n${respuesta}`);
          return;
        }

        if (response.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: response.content });
          const toolResults = [];
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue;
            console.log(`  🔧 Tool: ${block.name}`);
            const result = await executeTool(block.name, block.input);
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
          }
          messages.push({ role: 'user', content: toolResults });
        } else {
          break;
        }
      }
    } catch (e) {
      console.error('❌ Error conversación libre:', e.message);
      encolarMensaje(`conv-resp-${convId}`, `❌ Error: ${e.message}`);
    }
  }

  async function procesarInstruccionAdmin(texto, pendiente) {
    console.log(`  💬 Instrucción admin: "${texto.slice(0, 80)}"`);
    try {
      const contextoDatos = pendiente.tipo === 'alerta'
        ? `PROBLEMA: ${pendiente.datos.problema.problema}\nSUGERENCIA: ${pendiente.datos.problema.sugerencia}`
        : `PROPUESTA: ${pendiente.datos.descripcion}\nARCHIVO: ${pendiente.datos.archivo}`;

      const resp = await runAgentLoop(
        `Eres el asistente del monitor de calidad del bot de tacos. El admin te envía una instrucción.
Responde en español, conciso. Si pide cambio de código, usa proponer_cambio. Máximo 6 líneas.`,
        `${contextoDatos}\n\nMENSAJE DEL ADMIN: ${texto}`,
        executeTool
      );
      encolarMensaje(`resp-${pendiente.id}`, `🤖 *Monitor* [${pendiente.id}]\n\n${resp}`);
    } catch (e) {
      encolarMensaje(`resp-${pendiente.id}`, `❌ Error: ${e.message}`);
    }
  }

  async function procesarComandoAdmin(cmd) {
    switch (cmd.toLowerCase()) {

      case 'reporte':
        realizarAnalisisProfundo().catch(console.error);
        break;

      case 'estado': {
        const numConvs  = (() => { try { return memDb.countConversaciones(); } catch (e) { return '?'; } })();
        const numInterv = (() => { try { return JSON.parse(fs.readFileSync(INTERV_PATH, 'utf8')).length; } catch (e) { return 0; } })();
        const pends     = getPendientes();
        encolarMensaje('estado',
          `🤖 *Estado del Monitor*\n\n` +
          `📊 Conversaciones vigiladas: ${numConvs}\n` +
          `⚠️ Alertas hoy: ${estado.alertasHoy}\n` +
          `🚨 Intervenciones totales: ${numInterv}\n` +
          `🔧 Propuestas pendientes: ${pends.filter(p => p.tipo === 'propuesta').length}\n` +
          `🔔 Alertas pendientes: ${pends.filter(p => p.tipo === 'alerta').length}\n` +
          `🤖 Modelo: claude-sonnet-4-6`
        );
        break;
      }

      case 'propuestas': {
        const props = getPendientes().filter(p => p.tipo === 'propuesta');
        if (!props.length) {
          encolarMensaje('propuestas', '✅ No hay propuestas de código pendientes.');
        } else {
          const lista = props.map(p =>
            `[${p.datos.id}] ${p.datos.archivo} — ${p.datos.descripcion.slice(0, 80)}`
          ).join('\n');
          encolarMensaje('propuestas', `🔧 *Propuestas pendientes:*\n\n${lista}`);
        }
        break;
      }

      case 'reiniciar': {
        const ORCH_DB_PATH = process.env.ORCH_DB_PATH;
        if (ORCH_DB_PATH) {
          try {
            const Database = require('better-sqlite3');
            const orchDb   = new Database(ORCH_DB_PATH, { readonly: true });
            const falla    = orchDb.prepare(
              `SELECT en_cooldown FROM fallas WHERE servicio = 'TacosAragon' LIMIT 1`
            ).get();
            orchDb.close();
            if (falla && falla.en_cooldown === 1) {
              encolarMensaje('cmd-reiniciar-bloq',
                '⚠️ *Monitor:* Reinicio bloqueado — el orquestador ya está ejecutando una recuperación de TacosAragon.'
              );
              break;
            }
          } catch (e) {
            console.error('[monitor] No se pudo verificar estado del orquestador:', e.message);
          }
        }
        encolarMensaje('cmd-reiniciar', '🔄 *Monitor:* Reiniciando TacosAragon...');
        try {
          execSync('pm2 restart TacosAragon', { stdio: 'ignore' });
          encolarMensaje('cmd-reiniciar-ok', '✅ *Monitor:* `pm2 restart TacosAragon` ejecutado. Verificando en 90s...');
        } catch (e) {
          encolarMensaje('cmd-reiniciar-err', `❌ *Monitor:* Error al reiniciar: ${e.message}`);
        }
        break;
      }

      default:
        encolarMensaje('cmd-unknown',
          `❓ Comando no reconocido: "${cmd}"\n\n` +
          `Comandos válidos:\n` +
          `!m reporte → análisis profundo\n` +
          `!m estado → estado del monitor\n` +
          `!m propuestas → propuestas de código pendientes\n` +
          `!m reiniciar → reinicia TacosAragon`
        );
    }
  }

  let procesandoRespuestas = false;

  async function procesarRespuestas() {
    if (procesandoRespuestas) return;
    const responses = mensajesDb.leerResponsesPendientes();
    if (!responses.length) return;

    procesandoRespuestas = true;
    try {
      for (const resp of responses) {
        try {
          if (resp.id.startsWith('cmd-')) {
            await procesarComandoAdmin(resp.texto);
            mensajesDb.marcarResponseProcesada(resp.rowid);
            continue;
          }

          if (resp.id.startsWith('conv-')) {
            await procesarConversacionLibre(resp.id, resp.texto);
            mensajesDb.marcarResponseProcesada(resp.rowid);
            continue;
          }

          const lookupId  = resp.id.startsWith('propuesta-') ? resp.id.slice('propuesta-'.length) : resp.id;
          const pendiente = getPendientes().find(p => p.id === lookupId);
          if (!pendiente) { mensajesDb.marcarResponseProcesada(resp.rowid); continue; }

          const texto = (resp.texto || '').trim();
          console.log(`📨 Respuesta admin [${resp.id}]: "${texto.slice(0, 60)}"`);

          if (texto.toLowerCase() === 'si') {
            if (pendiente.tipo === 'propuesta') {
              await aplicarPropuesta(pendiente);
            } else {
              await aplicarSugerenciaAlerta(pendiente);
            }
          } else if (texto.toLowerCase() === 'no') {
            encolarMensaje(`resp-${resp.id}`, `🤖 Monitor — [${resp.id}] rechazado.`);
          } else {
            await procesarInstruccionAdmin(texto, pendiente);
          }

          setPendientes(getPendientes().filter(p => p.id !== lookupId));
          guardarPendientes(getPendientes());
          mensajesDb.marcarResponseProcesada(resp.rowid);

        } catch (err) {
          console.error(`[monitor] Error procesando respuesta ${resp.id}:`, err.message);
          mensajesDb.devolverResponseSinProcesar(resp.rowid);
        }
      }
    } finally {
      procesandoRespuestas = false;
    }
  }

  return { procesarComandoAdmin, procesarRespuestas };
}

module.exports = { crearProcesadorComandos, SYSTEM_PROFUNDO };
