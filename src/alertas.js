'use strict';

/**
 * alertas.js — Encola alertas de calidad al admin vía mensajes_queue SQLite.
 * También aplica sugerencias aprobadas (instrucciones.txt) y propuestas de código.
 */

const fs = require('fs');
const { anthropic, INSTRUCCIONES_PATH, mensajesDb } = require('./config');

function crearGestorAlertas({ encolarMensaje, getPendientes, addPendiente, getAlertaCounter, incAlertaCounter }) {

  function encolarAlerta(telefono, problema, intercambio) {
    incAlertaCounter();
    const id    = `M${getAlertaCounter()}`;
    const emoji = { alta: '🔴', media: '🟡', baja: '🟢' }[problema.severidad] || '⚪';
    const regla = problema.regla_violada ? `\n📋 *Regla:* _${problema.regla_violada}_\n` : '';

    encolarMensaje(id,
      `🤖 *MONITOR* [${id}]\n` +
      `${emoji} *${(problema.severidad || '').toUpperCase()}* | Cliente: ${telefono}\n\n` +
      `⚠️ *Problema:*\n${problema.problema}\n` +
      regla +
      `\n💬 *Fragmento:*\n_${problema.fragmento}_\n\n` +
      `💡 *Sugerencia:*\n${problema.sugerencia}\n\n` +
      `─────────────────────\n` +
      `!m si   → aplicar sugerencia\n` +
      `!m no   → ignorar\n` +
      `!m [texto]  → comentar o instruir`
    );
    addPendiente({ id, tipo: 'alerta', datos: { telefono, problema, intercambio }, timestamp: Date.now() });
    console.log(`  📤 Alerta encolada: ${id}`);
  }

  async function aplicarSugerenciaAlerta(pendiente) {
    const { telefono, problema } = pendiente.datos;
    console.log(`🔧 Aplicando sugerencia alerta [${pendiente.id}]...`);
    let instruccionesActuales = '';
    try {
      instruccionesActuales = fs.readFileSync(INSTRUCCIONES_PATH, 'utf8');
    } catch (e) {
      encolarMensaje(`resp-${pendiente.id}`, `❌ No se pudo leer instrucciones.txt: ${e.message}`);
      return;
    }
    try {
      const editResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 512,
        system: `Eres un editor de instrucciones para un bot de WhatsApp de tacos.
Genera UNA SOLA REGLA clara (máx 3 líneas) para añadir al final del archivo de instrucciones.
Solo el texto de la regla, sin explicaciones ni encabezados. En español, específico y accionable.`,
        messages: [{
          role: 'user',
          content: `PROBLEMA: ${problema.problema}\nSUGERENCIA: ${problema.sugerencia}\n\nGenera la regla:`,
        }],
      });
      const nuevaRegla = editResp.content[0].text.trim();
      const fecha = new Date().toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
      fs.writeFileSync(INSTRUCCIONES_PATH + '.bak', instruccionesActuales);
      fs.writeFileSync(INSTRUCCIONES_PATH,
        instruccionesActuales.trimEnd() +
        `\n\n--- REGLA MONITOR [${pendiente.id}] ${fecha} ---\n${nuevaRegla}\n`
      );
      encolarMensaje(`resp-${pendiente.id}`,
        `✅ *Instrucciones actualizadas* [${pendiente.id}]\n\n` +
        `📝 Regla añadida:\n_${nuevaRegla}_\n\n` +
        `⚠️ Reinicia el bot:\n` + '`pm2 restart TacosAragon`'
      );
      console.log(`  ✅ instrucciones.txt actualizado`);
    } catch (e) {
      encolarMensaje(`resp-${pendiente.id}`, `❌ Error aplicando sugerencia: ${e.message}`);
    }
  }

  async function aplicarPropuesta(pendiente) {
    const prop = pendiente.datos;
    console.log(`🔧 Aplicando propuesta [${prop.id}] en ${prop.archivo}...`);

    const { BASE } = require('./config');
    const path = require('path');
    const rutas = {
      'instrucciones.txt':       INSTRUCCIONES_PATH,
      'index.js':                path.join(BASE, 'index.js'),
      'loyverse_integration.js': path.join(BASE, 'loyverse_integration.js'),
    };
    const ruta = rutas[prop.archivo];
    if (!ruta || !fs.existsSync(ruta)) {
      encolarMensaje(`resp-${prop.id}`, `❌ Archivo no encontrado: ${prop.archivo}`);
      return;
    }
    try {
      const contenido = fs.readFileSync(ruta, 'utf8');
      fs.writeFileSync(ruta + '.bak', contenido);

      let nuevoContenido;
      if (prop.buscar) {
        if (!contenido.includes(prop.buscar)) {
          encolarMensaje(`resp-${prop.id}`,
            `❌ No se encontró el texto a reemplazar en ${prop.archivo}.\n` +
            `Backup guardado. Revisa manualmente.`
          );
          return;
        }
        nuevoContenido = contenido.replace(prop.buscar, prop.reemplazar);
      } else {
        nuevoContenido = contenido.trimEnd() + '\n\n' + prop.reemplazar + '\n';
      }

      fs.writeFileSync(ruta, nuevoContenido);
      prop.aplicada = true;
      const esJs = prop.archivo.endsWith('.js');
      encolarMensaje(`resp-${prop.id}`,
        `✅ *Propuesta ${prop.id} aplicada en ${prop.archivo}*\n\n` +
        `Backup: \`${prop.archivo}.bak\`\n\n` +
        (esJs
          ? `⚠️ *Reinicia el bot:*\n` + '`pm2 restart TacosAragon`'
          : `✅ instrucciones.txt actualizado\n⚠️ Reinicia: ` + '`pm2 restart TacosAragon`')
      );
      console.log(`  ✅ ${prop.archivo} actualizado.`);
    } catch (e) {
      encolarMensaje(`resp-${prop.id}`, `❌ Error aplicando propuesta ${prop.id}: ${e.message}`);
    }
  }

  return { encolarAlerta, aplicarSugerenciaAlerta, aplicarPropuesta };
}

module.exports = { crearGestorAlertas };
