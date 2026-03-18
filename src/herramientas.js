'use strict';

/**
 * herramientas.js — Definición de TOOLS para Anthropic + función executeTool.
 * Cada tool implementa una capacidad del agente monitor.
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');
const http          = require('http');

const {
  BASE, DATOS,
  INSTRUCCIONES_PATH, MENU_PATH, NO_DISP_PATH, LOY_CONFIG_PATH,
  INTERV_PATH, memDb, mensajesDb,
} = require('./config');
const { generarGrafica, generarVoz } = require('./media');

// ── TOOLS ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'leer_archivo',
    description: 'Lee el contenido de un archivo del bot. Úsalo para entender el código o las instrucciones antes de proponer cambios.',
    input_schema: {
      type: 'object',
      properties: {
        archivo: {
          type: 'string',
          enum: ['instrucciones.txt', 'menu.csv', 'no_disponible.txt',
                 'loyverse_config.json', 'index.js', 'loyverse_integration.js'],
          description: 'Archivo a leer',
        },
        offset: { type: 'number', description: 'Caracter de inicio (default 0)' },
        limite: { type: 'number', description: 'Máximo de caracteres (default 6000)' },
      },
      required: ['archivo'],
    },
  },
  {
    name: 'leer_conversacion',
    description: 'Lee el historial de conversación de un cliente. Últimas N chars.',
    input_schema: {
      type: 'object',
      properties: {
        telefono:     { type: 'string', description: 'Últimos 10 dígitos del teléfono' },
        ultimos_chars: { type: 'number', description: 'Cuántos caracteres finales leer (default 3000)' },
      },
      required: ['telefono'],
    },
  },
  {
    name: 'leer_perfil_cliente',
    description: 'Lee el perfil de un cliente (preferencias, pedidos frecuentes, etc.).',
    input_schema: {
      type: 'object',
      properties: { telefono: { type: 'string' } },
      required: ['telefono'],
    },
  },
  {
    name: 'leer_intervenciones',
    description: 'Lee el historial de intervenciones humanas.',
    input_schema: {
      type: 'object',
      properties: {
        limite: { type: 'number', description: 'Máximo de intervenciones (default 20)' },
      },
    },
  },
  {
    name: 'listar_conversaciones',
    description: 'Lista todos los clientes activos con metadata: teléfono, tamaño, última línea.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'buscar_en_conversaciones',
    description: 'Busca un patrón en todas las conversaciones.',
    input_schema: {
      type: 'object',
      properties: {
        patron:        { type: 'string', description: 'Texto a buscar (case insensitive)' },
        max_resultados: { type: 'number', description: 'Máximo de resultados (default 10)' },
      },
      required: ['patron'],
    },
  },
  {
    name: 'ejecutar_shell',
    description: `Ejecuta un comando de shell de solo lectura.
Ejemplos: tail -200 logs/error.log | pm2 status | grep -n "Error" logs/error.log | tail -50`,
    input_schema: {
      type: 'object',
      properties: {
        comando: {
          type: 'string',
          description: 'Comando de solo lectura (tail, cat, grep, pm2 status/logs, ls, wc).',
        },
      },
      required: ['comando'],
    },
  },
  {
    name: 'consultar_api',
    description: `Consulta datos de VENTAS, TICKETS y ESTADÍSTICAS del negocio via la API central.
Endpoints: /api/ventas/resumen | /api/ventas/empleados-ventas | /api/ventas/por-producto
           /api/ventas/grafica | /api/dashboard | /api/ventas/cierres | /api/ventas/ticket/N
Params periodo: hoy | ayer | semana | mes`,
    input_schema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Ruta del endpoint, ej: /api/ventas/resumen' },
        params:   { type: 'object', description: 'Query params opcionales, ej: {"periodo":"semana"}' },
      },
      required: ['endpoint'],
    },
  },
  {
    name: 'proponer_cambio',
    description: 'Propone un cambio en un archivo del bot para aprobación del admin.',
    input_schema: {
      type: 'object',
      properties: {
        archivo:     { type: 'string', enum: ['instrucciones.txt', 'index.js', 'loyverse_integration.js'] },
        descripcion: { type: 'string', description: 'Explicación del cambio' },
        buscar:      { type: 'string', description: 'Texto exacto a reemplazar' },
        reemplazar:  { type: 'string', description: 'Texto nuevo' },
      },
      required: ['archivo', 'descripcion', 'reemplazar'],
    },
  },
  {
    name: 'enviar_media',
    description: 'Genera y envía al admin una GRÁFICA (PNG) o un AUDIO (voz MP3).',
    input_schema: {
      type: 'object',
      properties: {
        tipo:         { type: 'string', enum: ['grafica', 'audio'] },
        datos_grafica: {
          type: 'object',
          properties: {
            titulo:       { type: 'string' },
            labels:       { type: 'array', items: { type: 'string' } },
            valores:      { type: 'array', items: { type: 'number' } },
            tipo_grafica: { type: 'string' },
            labelDataset: { type: 'string' },
          },
          required: ['titulo', 'labels', 'valores'],
        },
        texto_voz: { type: 'string', description: 'Texto a voz. Máx 200 chars.' },
        caption:   { type: 'string' },
      },
      required: ['tipo'],
    },
  },
  {
    name: 'cargar_skill',
    description: 'Carga el contexto especializado de un skill.',
    input_schema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          enum: ['conversacion', 'alertas', 'propuestas', 'logs', 'menu'],
        },
      },
      required: ['skill'],
    },
  },
];

// ── EJECUTOR DE TOOLS ─────────────────────────────────────────────────────────
// propuestaCounter y encolarMensaje/encolarMedia se inyectan desde el estado global
// para evitar dependencias circulares.

function crearExecuteTool({ getPropuestaCounter, incPropuestaCounter, getPendientes, addPendiente, encolarMensaje, encolarMedia }) {
  const API_URL   = process.env.TACOS_API_URL   || 'http://localhost:3001';
  const API_TOKEN = process.env.TACOS_API_TOKEN || '';

  function llamarApi(apiPath) {
    const parsed = new URL(apiPath, API_URL);
    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port:     parseInt(parsed.port) || 3001,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'x-api-token': API_TOKEN },
      };
      http.get(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  return async function executeTool(name, input) {
    try {
      switch (name) {

        case 'leer_archivo': {
          const rutas = {
            'instrucciones.txt':       INSTRUCCIONES_PATH,
            'menu.csv':                MENU_PATH,
            'no_disponible.txt':       NO_DISP_PATH,
            'loyverse_config.json':    LOY_CONFIG_PATH,
            'index.js':                path.join(BASE, 'index.js'),
            'loyverse_integration.js': path.join(BASE, 'loyverse_integration.js'),
          };
          const ruta = rutas[input.archivo];
          if (!ruta || !fs.existsSync(ruta)) return `Archivo no encontrado: ${input.archivo}`;
          const contenido = fs.readFileSync(ruta, 'utf8');
          const offset = input.offset || 0;
          const limite = input.limite  || 6000;
          const trozo  = contenido.slice(offset, offset + limite);
          return `[${input.archivo} — chars ${offset}–${offset + trozo.length} de ${contenido.length}]\n${trozo}`;
        }

        case 'leer_conversacion': {
          const conv = memDb.getConversacion(input.telefono);
          if (!conv) return `Sin conversación para ${input.telefono}`;
          return conv.slice(-(input.ultimos_chars || 3000));
        }

        case 'leer_perfil_cliente': {
          const perfil = memDb.getPerfil(input.telefono);
          return perfil || `Sin perfil para ${input.telefono}`;
        }

        case 'leer_intervenciones': {
          if (!fs.existsSync(INTERV_PATH)) return 'Sin intervenciones registradas aún.';
          const intervs = JSON.parse(fs.readFileSync(INTERV_PATH, 'utf8'));
          return JSON.stringify(intervs.slice(-(input.limite || 20)), null, 2);
        }

        case 'listar_conversaciones': {
          const rows  = memDb.getAllConversaciones();
          const lista = rows.map(row => ({
            telefono:   row.mem_key,
            chars:      (row.historial || '').length,
            ultimaLinea: (row.historial || '').split('\n').filter(Boolean).pop()?.slice(0, 80) || '',
          })).sort((a, b) => b.chars - a.chars);
          return JSON.stringify(lista.slice(0, 30), null, 2);
        }

        case 'buscar_en_conversaciones': {
          const rows   = memDb.getAllConversaciones();
          const patron = input.patron.toLowerCase();
          const max    = input.max_resultados || 10;
          const res    = [];
          for (const row of rows) {
            const conv = row.historial || '';
            const idx  = conv.toLowerCase().indexOf(patron);
            if (idx === -1) continue;
            res.push({ telefono: row.mem_key, fragmento: conv.slice(Math.max(0, idx - 120), idx + 300) });
            if (res.length >= max) break;
          }
          return res.length ? JSON.stringify(res, null, 2) : `"${patron}" no encontrado.`;
        }

        case 'ejecutar_shell': {
          const cmd = (input.comando || '').trim();
          if (!cmd) return 'Comando vacío.';
          const PERMITIDOS = /^(tail|cat|head|grep|pm2\s+(status|list|logs|info)|ls|wc|find\s+logs|type)\s/i;
          const BLOQUEADOS = /[;&|`$(){}]|rm\s|del\s|kill\s|restart\s|stop\s|start\s|>\s|>>/i;
          if (!PERMITIDOS.test(cmd + ' ') || BLOQUEADOS.test(cmd)) {
            return `❌ Comando no permitido: "${cmd}"`;
          }
          try {
            const salida = execSync(cmd, {
              cwd: BASE, timeout: 15000,
              maxBuffer: 1024 * 512, encoding: 'utf8', shell: true, windowsHide: true,
            }).trim();
            if (!salida) return '(sin salida)';
            return salida.length > 8000 ? salida.slice(-8000) + '\n[... truncado]' : salida;
          } catch (e) {
            return (e.stdout || e.stderr || e.message || '').toString().trim() || `Error: ${e.message}`;
          }
        }

        case 'proponer_cambio': {
          incPropuestaCounter();
          const id       = `P${getPropuestaCounter()}`;
          const esJs     = input.archivo.endsWith('.js');
          const propuesta = {
            id, archivo: input.archivo, descripcion: input.descripcion,
            buscar: input.buscar || '', reemplazar: input.reemplazar,
            timestamp: Date.now(), aplicada: false,
          };
          addPendiente({ id, tipo: 'propuesta', datos: propuesta, timestamp: Date.now() });

          const preview = input.buscar
            ? `🔴 _Reemplazar:_\n\`${input.buscar.slice(0, 180)}\`\n\n🟢 _Con:_\n\`${input.reemplazar.slice(0, 180)}\``
            : `🟢 _Añadir al final:_\n\`${input.reemplazar.slice(0, 300)}\``;

          encolarMensaje(
            `propuesta-${id}`,
            `🔧 *PROPUESTA DE CÓDIGO* [${id}]\n` +
            `📄 Archivo: \`${input.archivo}\`\n\n` +
            `💡 ${input.descripcion}\n\n` +
            `${preview}\n\n` +
            (esJs ? `⚠️ _Se hará backup automático antes de aplicar_\n\n` : '') +
            `!m si  →  aplicar\n!m no  →  rechazar`
          );
          return `Propuesta ${id} creada y enviada al admin.`;
        }

        case 'cargar_skill': {
          const skillPath = path.join(__dirname, '..', 'skills', `${input.skill}.md`);
          if (!fs.existsSync(skillPath)) return `Skill '${input.skill}' no encontrado.`;
          return `[SKILL CARGADO: ${input.skill}]\n\n${fs.readFileSync(skillPath, 'utf8')}`;
        }

        case 'consultar_api': {
          const { endpoint, params } = input;
          let url = endpoint;
          if (params && Object.keys(params).length > 0) {
            url += '?' + new URLSearchParams(params).toString();
          }
          const result = await llamarApi(url);
          if (result && Array.isArray(result.recibos)) {
            const { recibos, ...resto } = result;
            return JSON.stringify({ ...resto, recibos_omitidos: recibos.length }, null, 2);
          }
          return JSON.stringify(result, null, 2);
        }

        case 'enviar_media': {
          const { tipo, datos_grafica, texto_voz, caption } = input;
          try {
            if (tipo === 'grafica') {
              if (!datos_grafica?.labels?.length || !datos_grafica?.valores?.length) {
                return 'Error: datos_grafica debe incluir titulo, labels[] y valores[].';
              }
              const filePath = await generarGrafica({
                titulo:       datos_grafica.titulo      || 'Ventas',
                labels:       datos_grafica.labels,
                valores:      datos_grafica.valores,
                tipo:         datos_grafica.tipo_grafica || 'bar',
                labelDataset: datos_grafica.labelDataset || 'Ventas $',
              });
              encolarMedia(`grafica-${Date.now()}`, 'imagen', filePath, caption || datos_grafica.titulo);
              return `Gráfica generada: ${path.basename(filePath)}`;
            }
            if (tipo === 'audio') {
              if (!texto_voz?.trim()) return 'Error: texto_voz es requerido.';
              const filePath = await generarVoz(texto_voz.trim());
              encolarMedia(`voz-${Date.now()}`, 'audio', filePath, caption || '');
              return `Audio generado: ${path.basename(filePath)}`;
            }
            return `Tipo '${tipo}' no soportado.`;
          } catch (err) {
            return `Error generando media: ${err.message}`;
          }
        }

        default:
          return `Tool '${name}' no implementada.`;
      }
    } catch (e) {
      return `Error en tool ${name}: ${e.message}`;
    }
  };
}

module.exports = { TOOLS, crearExecuteTool };
