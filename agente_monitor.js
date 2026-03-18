'use strict';
// ─── AGENTE MONITOR DE CALIDAD — Tacos Aragón ────────────────────────────────
// Este archivo se mantiene por compatibilidad con PM2 (ecosystem.config.js apunta aquí).
// Toda la lógica vive en index.js y src/.
require('./index.js');

/* ──────────────────────────────────────────────────────────────────────────────
   CÓDIGO LEGACY — mantenido como referencia histórica, no se ejecuta.
   La implementación activa está en:
     index.js        ← orquestación + intervalos
     src/config.js   ← rutas, Anthropic client, módulos DB
     src/estado_db.js← persistencia SQLite (reemplaza JSON files)
     src/herramientas.js ← TOOLS + executeTool
     src/agente.js   ← runAgentLoop
     src/watcher.js  ← monitoreo en tiempo real de conversaciones
     src/alertas.js  ← alertas + aplicar sugerencias/propuestas
     src/comandos.js ← comandos del admin + conversación libre
     src/pm2_watcher.js ← detección reinicios + verificación WhatsApp
     src/log_watcher.js ← análisis de logs de error
────────────────────────────────────────────────────────────────────────────── */
return; // eslint-disable-line no-unreachable
// Proceso independiente con acceso completo a la API de Anthropic (claude-sonnet-4-6).
// Capacidades:
//   • Monitoreo en tiempo real de cada mensaje del bot
//   • Acceso a todas las conversaciones, perfiles y archivos del sistema
//   • Lectura de intervenciones humanas (!humano / !pausa)
//   • Análisis profundo con tool use (bucle agéntico)
//   • Propuestas de cambios a instrucciones.txt, index.js, loyverse_integration.js
//   • Reporte bajo demanda y análisis nocturno automático
//
// Comandos del admin vía WhatsApp:
//   !m si          → aplicar última alerta/propuesta pendiente
//   !m no          → rechazar última alerta/propuesta pendiente
//   !m reporte     → análisis profundo inmediato con tool use
//   !m estado      → estado del monitor (sin llamada a IA)
//   !m propuestas  → lista de propuestas pendientes de código
//   !m [texto]     → instrucción libre al monitor
// ─────────────────────────────────────────────────────────────────────────────

const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const https         = require('https');
const { execSync }  = require('child_process');
const Anthropic     = require('@anthropic-ai/sdk');

// ── RUTAS ─────────────────────────────────────────────────────────────────────
// BOT_BASE apunta al directorio raíz del bot principal (donde están datos/ y logs/).
// Por defecto asume que el bot está en ../bot-tacos respecto a este repo.
const BASE              = process.env.BOT_BASE || path.join(__dirname, '..', 'bot-tacos');
const DATOS             = path.join(BASE, 'datos');
const INSTRUCCIONES_PATH= path.join(DATOS, 'instrucciones.txt');
const MENU_PATH         = path.join(DATOS, 'menu.csv');
const NO_DISP_PATH      = path.join(DATOS, 'no_disponible.txt');
const LOY_CONFIG_PATH   = path.join(DATOS, 'loyverse_config.json');
const memDb             = require(path.resolve(BASE, 'datos', 'memoria_db'));
const mensajesDb        = require(path.resolve(BASE, 'datos', 'mensajes_db'));
const INTERV_PATH       = path.join(DATOS, 'intervenciones_humanas.json');
const ESTADO_PATH       = path.join(DATOS, 'agente_estado.json');
const PENDIENTES_PATH   = path.join(DATOS, 'agente_pendientes.json');
const LOGS_DIR          = path.join(BASE, 'logs');
const ERROR_LOG         = path.join(LOGS_DIR, 'error.log');
const OUTPUT_LOG        = path.join(LOGS_DIR, 'output.log');

// ── API KEY ───────────────────────────────────────────────────────────────────
let ANTHROPIC_KEY = '';
try {
    ANTHROPIC_KEY = process.env.ANTHROPIC_KEY ||
        fs.readFileSync(path.join(DATOS, 'anthropic_key.txt'), 'utf8').trim();
} catch (e) {
    console.error('❌ Falta ANTHROPIC_KEY. Ponlo en env o en datos/anthropic_key.txt');
    process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── ESTADO ────────────────────────────────────────────────────────────────────
let estadoConv       = {};  // { phone: lastAnalyzedLength }
let estadoLogs       = { errorLogSize: 0, outputLogSize: 0 }; // tamaño último analizado
let pendientes       = [];  // [{ id, tipo:'alerta'|'propuesta', datos, timestamp }]
let alertaCounter    = 0;
let propuestaCounter = 0;
let alertasHoy       = 0;
let fechaHoy         = new Date().toDateString();

function resetContadorDiario() {
    const hoy = new Date().toDateString();
    if (hoy !== fechaHoy) { alertasHoy = 0; fechaHoy = hoy; }
}

try {
    if (fs.existsSync(ESTADO_PATH))
        estadoConv = JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
} catch (e) { estadoConv = {}; }

function guardarEstado() {
    try { fs.writeFileSync(ESTADO_PATH, JSON.stringify(estadoConv, null, 2)); } catch (e) {}
}

function guardarPendientes() {
    try { fs.writeFileSync(PENDIENTES_PATH, JSON.stringify(pendientes, null, 2)); } catch (e) {}
}

// ── LLAMADA HTTP A LA API CENTRAL ─────────────────────────────────────────────
function llamarApi(apiPath) {
    const API_URL   = process.env.TACOS_API_URL   || 'http://localhost:3001';
    const API_TOKEN = process.env.TACOS_API_TOKEN || '';
    const parsed    = new URL(apiPath, API_URL);
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

// ── COLA / RESPUESTAS (SQLite via mensajes_db) ────────────────────────────────
function encolarMensaje(id, mensaje) {
    mensajesDb.encolarMensaje(id, mensaje, 'monitor');
}

function encolarMedia(id, tipo, filePath, caption) {
    mensajesDb.encolarMedia(id, tipo, filePath, caption, 'monitor');
}

// ── GENERACIÓN DE MEDIA (gráficas, audio) ─────────────────────────────────────
const TEMP_DIR = path.join(BASE, 'temp');
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch(e) {}

/** Descarga cualquier URL HTTPS/HTTP a un archivo local, siguiendo redirects */
function descargarArchivo(url, destino) {
    return new Promise((resolve, reject) => {
        const doGet = (targetUrl, saltos = 0) => {
            if (saltos > 5) { reject(new Error('Demasiados redirects')); return; }
            const lib = targetUrl.startsWith('https') ? https : http;
            lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 TacosBot/1.0' } }, res => {
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                    doGet(res.headers.location, saltos + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} al descargar ${targetUrl}`));
                    return;
                }
                const file = fs.createWriteStream(destino);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(destino); });
                file.on('error', reject);
            }).on('error', reject);
        };
        doGet(url);
    });
}

/**
 * Genera una gráfica PNG usando quickchart.io y la guarda en TEMP_DIR.
 * @param {object} opts - { titulo, labels, valores, tipo:'bar'|'line'|'horizontalBar', labelDataset }
 * @returns {Promise<string>} ruta del PNG generado
 */
async function generarGrafica({ titulo, labels, valores, tipo = 'bar', labelDataset = 'Ventas $' }) {
    const COLORES = ['#E07B39','#D4623A','#C94E2B','#BE3A1C','#B3260D','#FF9966','#FFCC99','#FF6633'];
    const esLinea = tipo === 'line';
    const config = {
        type: tipo,
        data: {
            labels,
            datasets: [{
                label: labelDataset,
                data: valores,
                backgroundColor: esLinea ? 'rgba(224,123,57,0.2)' : labels.map((_, i) => COLORES[i % COLORES.length]),
                borderColor: '#E07B39',
                borderWidth: 2,
                fill: esLinea,
                tension: 0.3,
                pointRadius: 4,
            }],
        },
        options: {
            title:  { display: true, text: titulo, fontSize: 16, fontColor: '#333' },
            legend: { display: true },
            scales: {
                yAxes: [{ ticks: { beginAtZero: true } }],
                xAxes: [{ ticks: { maxRotation: 45 } }],
            },
        },
    };
    const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=700&h=420&bkg=white&f=png`;
    const destino  = path.join(TEMP_DIR, `grafica_${Date.now()}.png`);
    await descargarArchivo(chartUrl, destino);
    return destino;
}

/**
 * Genera un audio MP3 con Google TTS (español) y lo guarda en TEMP_DIR.
 * Máx 200 caracteres para evitar error en la API.
 */
async function generarVoz(texto) {
    const textoCortado = texto.slice(0, 200);
    const encoded  = encodeURIComponent(textoCortado);
    const url      = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=es&client=tw-ob&ttsspeed=0.85`;
    const destino  = path.join(TEMP_DIR, `voz_${Date.now()}.mp3`);
    await descargarArchivo(url, destino);
    return destino;
}

// ── DEFINICIÓN DE TOOLS (Anthropic tool use) ─────────────────────────────────
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
                    description: 'Archivo a leer'
                },
                offset: { type: 'number', description: 'Caracter de inicio (para leer en partes, default 0)' },
                limite:  { type: 'number', description: 'Máximo de caracteres a retornar (default 6000)' }
            },
            required: ['archivo']
        }
    },
    {
        name: 'leer_conversacion',
        description: 'Lee el historial de conversación de un cliente. Últimas N líneas.',
        input_schema: {
            type: 'object',
            properties: {
                telefono: { type: 'string', description: 'Últimos 10 dígitos del teléfono' },
                ultimos_chars: { type: 'number', description: 'Cuántos caracteres finales leer (default 3000)' }
            },
            required: ['telefono']
        }
    },
    {
        name: 'leer_perfil_cliente',
        description: 'Lee el perfil de un cliente (preferencias, pedidos frecuentes, etc.).',
        input_schema: {
            type: 'object',
            properties: { telefono: { type: 'string' } },
            required: ['telefono']
        }
    },
    {
        name: 'leer_intervenciones',
        description: 'Lee el historial de intervenciones humanas: casos donde un admin tuvo que tomar control del bot manualmente.',
        input_schema: {
            type: 'object',
            properties: {
                limite: { type: 'number', description: 'Máximo de intervenciones a retornar (default 20)' }
            }
        }
    },
    {
        name: 'listar_conversaciones',
        description: 'Lista todos los clientes activos con metadata: teléfono, tamaño de conversación, última línea.',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'buscar_en_conversaciones',
        description: 'Busca un patrón en todas las conversaciones. Útil para detectar problemas recurrentes.',
        input_schema: {
            type: 'object',
            properties: {
                patron: { type: 'string', description: 'Texto a buscar (case insensitive)' },
                max_resultados: { type: 'number', description: 'Máximo de resultados (default 10)' }
            },
            required: ['patron']
        }
    },
    {
        name: 'ejecutar_shell',
        description: `Ejecuta un comando de shell de solo lectura en el servidor del bot.
Úsalo para: leer logs (error.log, output.log), ver estado de PM2, buscar errores en logs.
SOLO comandos seguros de lectura — NO se permiten comandos que modifiquen el sistema.
Ejemplos útiles:
  tail -200 logs/error.log
  tail -300 logs/output.log
  pm2 status
  pm2 logs TacosAragon --lines 50 --nostream
  grep -n "Error\\|error\\|❌" logs/error.log | tail -50
  grep -n "ORDEN CONFIRMADA\\|Loyverse" logs/output.log | tail -30`,
        input_schema: {
            type: 'object',
            properties: {
                comando: {
                    type: 'string',
                    description: 'Comando a ejecutar. Solo lectura (tail, cat, grep, pm2 status/logs, ls, wc).'
                }
            },
            required: ['comando']
        }
    },
    {
        name: 'consultar_api',
        description: `Consulta datos de VENTAS, TICKETS y ESTADÍSTICAS del negocio via la API central.
USA ESTE TOOL (no ejecutar_shell) para cualquier pregunta sobre ventas, dinero, domicilios, productos vendidos, promedios, empleados, métodos de pago.

PERIODO válido para todos los endpoints: hoy | ayer | semana (mar–hoy GMT-7) | mes

Endpoints disponibles:
  /api/ventas/resumen          → PREFERIDO para cualquier resumen de ventas.
                                  Retorna: total, pedidos, ticketPromedio, porPago (nombres), porCanal, topProductos
                                  Params: periodo=hoy|ayer|semana|mes  (o desde= hasta= manuales)
  /api/ventas/empleados-ventas → ventas y pedidos por empleado en una sola llamada.
                                  Params: periodo=hoy|ayer|semana|mes
  /api/ventas/por-producto     → suma de dinero y cantidad de un producto por nombre parcial.
                                  Params: nombre (requerido), periodo=hoy|ayer|semana|mes
  /api/ventas/grafica          → ventas agrupadas para analizar tendencias.
                                  Params: periodo=hoy|ayer|semana|mes, agrupar=dia|hora|semana|mes
  /api/dashboard               → resumen completo hoy+semana+mes+gráficas en una llamada
  /api/ventas/ticket/NUMERO    → detalle de un ticket específico
  /api/ventas/tipos-pago       → lista tipos de pago con id y nombre
  /api/ventas/empleados        → lista empleados con id y nombre
  /api/ventas/cierres          → cierres de caja (shifts): apertura/cierre, quién abrió/cerró, caja inicial,
                                  efectivo esperado vs real, diferencia, ventas netas, descuentos, entradas/salidas.
                                  Params: periodo=hoy|ayer|semana|mes  (o desde= hasta= manuales)

Mapeo de preguntas → endpoints:
  "¿cuánto vendimos hoy?"            → /api/ventas/resumen?periodo=hoy
  "¿cuánto esta semana?"             → /api/ventas/resumen?periodo=semana
  "¿cuánto ayer?"                    → /api/ventas/resumen?periodo=ayer
  "¿cuánto este mes?"                → /api/ventas/resumen?periodo=mes
  "¿cuánto en efectivo/tarjeta?"     → /api/ventas/resumen?periodo=semana  (porPago ya viene con nombres)
  "¿cuánto de domicilio/envíos?"     → /api/ventas/por-producto?nombre=domicilio&periodo=semana
  "¿quién vendió más?"               → /api/ventas/empleados-ventas?periodo=semana
  "¿a qué hora vendemos más?"        → /api/ventas/grafica?periodo=semana&agrupar=hora
  "¿cuál es el mejor día?"           → /api/ventas/grafica?periodo=semana&agrupar=dia
  "resumen general"                  → /api/dashboard
  "¿cuántos tacos de asada/adobada?" → /api/ventas/por-producto?nombre=asada&periodo=semana
  "¿cuánto había en caja?"           → /api/ventas/cierres?periodo=hoy
  "¿hubo diferencia en caja?"        → /api/ventas/cierres?periodo=semana
  "¿a qué hora abrieron/cerraron?"   → /api/ventas/cierres?periodo=hoy
  "¿quién abrió/cerró la caja?"      → /api/ventas/cierres?periodo=hoy`,
        input_schema: {
            type: 'object',
            properties: {
                endpoint: {
                    type: 'string',
                    description: 'Ruta del endpoint, ej: /api/ventas/por-producto'
                },
                params: {
                    type: 'object',
                    description: 'Parámetros de query opcionales, ej: {"nombre":"domicilio","periodo":"semana"}'
                }
            },
            required: ['endpoint']
        }
    },
    {
        name: 'proponer_cambio',
        description: 'Propone un cambio en un archivo del bot. Se enviará al admin para aprobación. El admin responde con "!m si" para aplicar o "!m no" para rechazar. Para archivos .js se hace backup automático antes de aplicar.',
        input_schema: {
            type: 'object',
            properties: {
                archivo: {
                    type: 'string',
                    enum: ['instrucciones.txt', 'index.js', 'loyverse_integration.js'],
                    description: 'Archivo a modificar'
                },
                descripcion: { type: 'string', description: 'Explicación del cambio y por qué es necesario' },
                buscar: { type: 'string', description: 'Texto exacto a reemplazar. Si se omite, se añade al final del archivo.' },
                reemplazar: { type: 'string', description: 'Texto nuevo. Si buscar está vacío, se añade al final.' }
            },
            required: ['archivo', 'descripcion', 'reemplazar']
        }
    },
    {
        name: 'enviar_media',
        description: `Genera y envía al admin una GRÁFICA (imagen PNG) o un AUDIO (voz en español).
Úsalo cuando el admin pide:
- "mándame una gráfica", "quiero ver el chart", "imagen de ventas", "visualización"
- "explícame por voz", "mándame un audio", "dímelo en audio", "resumen en voz"

FLUJO para gráfica de ventas:
  1. Llama consultar_api para obtener los datos (ej: /api/ventas/grafica?periodo=semana&agrupar=dia)
  2. Llama enviar_media con tipo=grafica y los datos formateados
  3. Después del envío, responde con un resumen de texto del mismo dato

Tipos de gráfica (campo tipo_grafica): "bar" (barras) | "line" (línea) | "horizontalBar" (barras horizontales)
- bar: ideal para ventas por día, por empleado, por producto
- line: ideal para tendencias en el tiempo
- horizontalBar: ideal para comparar pocos items (top productos, canales)`,
        input_schema: {
            type: 'object',
            properties: {
                tipo: {
                    type: 'string',
                    enum: ['grafica', 'audio'],
                    description: 'grafica=imagen de gráfica | audio=resumen en voz MP3'
                },
                datos_grafica: {
                    type: 'object',
                    description: 'Requerido si tipo=grafica. Campos: titulo (string), labels (string[]), valores (number[]), tipo_grafica ("bar"|"line"|"horizontalBar"), labelDataset (string, ej: "Ventas $")',
                    properties: {
                        titulo:       { type: 'string' },
                        labels:       { type: 'array', items: { type: 'string' } },
                        valores:      { type: 'array', items: { type: 'number' } },
                        tipo_grafica: { type: 'string' },
                        labelDataset: { type: 'string' },
                    },
                    required: ['titulo', 'labels', 'valores'],
                },
                texto_voz: {
                    type: 'string',
                    description: 'Requerido si tipo=audio. Texto a convertir en voz. Máx 200 caracteres. Sé conciso.'
                },
                caption: {
                    type: 'string',
                    description: 'Texto opcional que acompaña la gráfica como pie de foto'
                }
            },
            required: ['tipo']
        }
    },
    {
        name: 'cargar_skill',
        description: 'Carga el contexto especializado de un skill antes de hacer análisis. Úsalo al inicio de cada tarea para cargar solo el conocimiento relevante y reducir tokens. Elige el skill según la tarea.',
        input_schema: {
            type: 'object',
            properties: {
                skill: {
                    type: 'string',
                    enum: ['conversacion', 'alertas', 'propuestas', 'logs', 'menu'],
                    description: 'conversacion=analizar errores del bot con clientes | alertas=criterios para enviar alertas | propuestas=cómo proponer cambios de código | logs=interpretar logs de PM2 | menu=disponibilidad y reglas del menú'
                }
            },
            required: ['skill']
        }
    }
];

// ── EJECUCIÓN DE TOOLS ────────────────────────────────────────────────────────
async function executeTool(name, input) {
    try {
        switch (name) {

            case 'leer_archivo': {
                const rutas = {
                    'instrucciones.txt':        INSTRUCCIONES_PATH,
                    'menu.csv':                 MENU_PATH,
                    'no_disponible.txt':        NO_DISP_PATH,
                    'loyverse_config.json':     LOY_CONFIG_PATH,
                    'index.js':                 path.join(BASE, 'index.js'),
                    'loyverse_integration.js':  path.join(BASE, 'loyverse_integration.js')
                };
                const ruta = rutas[input.archivo];
                if (!ruta || !fs.existsSync(ruta)) return `Archivo no encontrado: ${input.archivo}`;
                const contenido = fs.readFileSync(ruta, 'utf8');
                const offset = input.offset || 0;
                const limite = input.limite || 6000;
                const trozo  = contenido.slice(offset, offset + limite);
                return `[${input.archivo} — chars ${offset}–${offset + trozo.length} de ${contenido.length}]\n${trozo}`;
            }

            case 'leer_conversacion': {
                const conv = memDb.getConversacion(input.telefono);
                if (!conv) return `Sin conversación para ${input.telefono}`;
                const n = input.ultimos_chars || 3000;
                return conv.slice(-n);
            }

            case 'leer_perfil_cliente': {
                const perfil = memDb.getPerfil(input.telefono);
                if (!perfil) return `Sin perfil para ${input.telefono}`;
                return perfil;
            }

            case 'leer_intervenciones': {
                if (!fs.existsSync(INTERV_PATH)) return 'Sin intervenciones registradas aún.';
                const intervs = JSON.parse(fs.readFileSync(INTERV_PATH, 'utf8'));
                const lim = input.limite || 20;
                return JSON.stringify(intervs.slice(-lim), null, 2);
            }

            case 'listar_conversaciones': {
                const rows = memDb.getAllConversaciones();
                const lista = rows.map(row => ({
                    telefono: row.mem_key,
                    chars: (row.historial || '').length,
                    ultimaLinea: (row.historial || '').split('\n').filter(Boolean).pop()?.slice(0, 80) || ''
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
                    if (!conv) continue;
                    const idx = conv.toLowerCase().indexOf(patron);
                    if (idx === -1) continue;
                    const inicio = Math.max(0, idx - 120);
                    const fin    = Math.min(conv.length, idx + 300);
                    res.push({ telefono: row.mem_key, fragmento: conv.slice(inicio, fin) });
                    if (res.length >= max) break;
                }
                if (!res.length) return `"${patron}" no encontrado en ninguna conversación.`;
                return JSON.stringify(res, null, 2);
            }

            case 'ejecutar_shell': {
                const cmd = (input.comando || '').trim();
                if (!cmd) return 'Comando vacío.';

                // Whitelist: solo comandos de lectura seguros
                const PERMITIDOS = /^(tail|cat|head|grep|pm2\s+(status|list|logs|info)|ls|wc|find\s+logs|type)\s/i;
                const BLOQUEADOS = /[;&|`$(){}]|rm\s|del\s|kill\s|restart\s|stop\s|start\s|>\s|>>/i;

                if (!PERMITIDOS.test(cmd + ' ') || BLOQUEADOS.test(cmd)) {
                    return `❌ Comando no permitido: "${cmd}"\nSolo se permiten comandos de lectura: tail, cat, grep, pm2 status/logs, ls, wc`;
                }

                try {
                    const salida = execSync(cmd, {
                        cwd: BASE,
                        timeout: 15000,
                        maxBuffer: 1024 * 512, // 512 KB máx
                        encoding: 'utf8',
                        shell: true,
                        windowsHide: true
                    });
                    const resultado = (salida || '').trim();
                    if (!resultado) return '(sin salida)';
                    // Truncar si es muy largo
                    return resultado.length > 8000
                        ? resultado.slice(-8000) + '\n[... truncado, usa tail -N para ajustar]'
                        : resultado;
                } catch (e) {
                    // execSync lanza error si el comando retorna exit code != 0 (ej. grep sin matches)
                    const output = (e.stdout || e.stderr || e.message || '').toString().trim();
                    return output || `Error ejecutando comando: ${e.message}`;
                }
            }

            case 'proponer_cambio': {
                propuestaCounter++;
                const id = `P${propuestaCounter}`;
                const esJs = input.archivo.endsWith('.js');
                const propuesta = {
                    id, archivo: input.archivo, descripcion: input.descripcion,
                    buscar: input.buscar || '', reemplazar: input.reemplazar,
                    timestamp: Date.now(), aplicada: false
                };

                pendientes.push({ id, tipo: 'propuesta', datos: propuesta, timestamp: Date.now() });
                guardarPendientes();

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

                return `Propuesta ${id} creada y enviada al admin para aprobación.`;
            }

            case 'cargar_skill': {
                const skillPath = path.join(__dirname, 'skills', `${input.skill}.md`);
                if (!fs.existsSync(skillPath)) return `Skill '${input.skill}' no encontrado.`;
                const contenido = fs.readFileSync(skillPath, 'utf8');
                return `[SKILL CARGADO: ${input.skill}]\n\n${contenido}`;
            }

            case 'consultar_api': {
                const { endpoint, params } = input;
                let url = endpoint;
                if (params && Object.keys(params).length > 0) {
                    url += '?' + new URLSearchParams(params).toString();
                }
                const result = await llamarApi(url);
                // Evitar devolver array completo de recibos (puede ser enorme).
                // El endpoint /api/ventas/resumen ya no los incluye; esto es fallback.
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
                        return `Gráfica generada y encolada para envío al admin: ${path.basename(filePath)}`;
                    }

                    if (tipo === 'audio') {
                        if (!texto_voz?.trim()) return 'Error: texto_voz es requerido para tipo=audio.';
                        const filePath = await generarVoz(texto_voz.trim());
                        encolarMedia(`voz-${Date.now()}`, 'audio', filePath, caption || '');
                        return `Audio generado y encolado para envío al admin: ${path.basename(filePath)}`;
                    }

                    return `Tipo '${tipo}' no soportado. Usa: grafica | audio`;
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
}

// ── BUCLE AGÉNTICO (tool use) ─────────────────────────────────────────────────
async function runAgentLoop(systemPrompt, userMessage, maxIter = 12) {
    const messages = [{ role: 'user', content: userMessage }];
    let iter = 0;

    while (iter++ < maxIter) {
        const response = await anthropic.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 4096,
            system:     systemPrompt,
            tools:      TOOLS,
            messages
        });

        if (response.stop_reason === 'end_turn') {
            return response.content.find(c => c.type === 'text')?.text || '';
        }

        if (response.stop_reason === 'tool_use') {
            messages.push({ role: 'assistant', content: response.content });
            const toolResults = [];
            for (const block of response.content) {
                if (block.type !== 'tool_use') continue;
                console.log(`  🔧 Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
                const result = await executeTool(block.name, block.input);
                toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
            }
            messages.push({ role: 'user', content: toolResults });
        } else {
            break;
        }
    }
    return 'Análisis completado.';
}

// ── MONITOREO EN TIEMPO REAL (llamada rápida, sin tools) ─────────────────────
// Cache del system prompt para no releer archivos en cada análisis
let _quickSystemCache = null;
let _quickSystemMtime = 0;

function buildQuickSystem() {
    let instrucciones = '';
    let menu = '';
    let noDisp = '';
    try {
        // Releer instrucciones si el archivo cambió desde el último análisis
        const mtime = fs.statSync(INSTRUCCIONES_PATH).mtimeMs;
        if (mtime !== _quickSystemMtime) {
            _quickSystemCache = null;
            _quickSystemMtime = mtime;
        }
        instrucciones = fs.readFileSync(INSTRUCCIONES_PATH, 'utf8');
    } catch(e) {}
    try { menu = fs.readFileSync(MENU_PATH, 'utf8'); } catch(e) {}
    try { noDisp = fs.readFileSync(NO_DISP_PATH, 'utf8').trim(); } catch(e) {}

    // Extraer sólo los nombres de productos del CSV para no inflar el prompt
    const menuLineas = menu.split('\n').slice(0, 120).join('\n'); // primeras ~120 líneas

    return `Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.
Recibirás el historial reciente de una conversación y los mensajes nuevos a evaluar.
Tu trabajo: detectar errores REALES y CONCRETOS del bot. Sé preciso, no reportes falsos positivos.

════════════════════════════════════════════
INSTRUCCIONES COMPLETAS DEL BOT (conócelas a fondo):
════════════════════════════════════════════
${instrucciones}

════════════════════════════════════════════
MENÚ VIGENTE (CSV):
════════════════════════════════════════════
${menuLineas}
${noDisp ? `\n⛔ NO DISPONIBLES HOY (no sugerir ni confirmar nunca):\n${noDisp}\n` : ''}
════════════════════════════════════════════
QUÉ DEBES DETECTAR:
════════════════════════════════════════════
1. Precio incorrecto (distinto al menú vigente)
2. Ítem NO DISPONIBLE sugerido, ofrecido o incluido en orden
3. Orden confirmada con ítems que el cliente NO pidió, o faltantes respecto a lo que pidió
4. El bot mencionó el nombre del cliente (TOTALMENTE PROHIBIDO)
5. El bot preguntó, ofreció o sugirió facturación sin que el cliente la solicitara
6. Respuesta fuera de contexto del negocio o completamente irrelevante
7. Se enviaron datos de pago sin que hubiera una ORDEN CONFIRMADA en ese mensaje
8. El bot ignoró o contradijo cualquier otra regla explícita de las instrucciones
9. Errores de tono: el bot fue grosero, condescendiente o inapropiado
10. El bot dio información falsa sobre horarios, métodos de pago o políticas del negocio

CRITERIO: Usa el historial reciente como contexto para entender la conversación completa.
Evalúa los mensajes nuevos a la luz del historial — no los juzgues fuera de contexto.

Si todo está bien → responde SOLO la palabra: OK
Si hay problema → responde SOLO JSON (sin markdown, sin bloques de código, JSON puro):
{"problema":"qué hizo mal el bot (específico)","severidad":"alta|media|baja","fragmento":"cita literal del texto erróneo (máx 250 chars)","sugerencia":"corrección concreta y accionable","regla_violada":"qué regla de las instrucciones se incumplió"}`;
}

async function analizarIntercambioRapido(telefono, contextoCompleto, nuevasLineas) {
    try {
        const userContent =
            `CLIENTE: ${telefono}\n\n` +
            `══ HISTORIAL RECIENTE (contexto) ══\n${contextoCompleto}\n\n` +
            `══ MENSAJES NUEVOS A EVALUAR ══\n${nuevasLineas}`;

        const resp = await anthropic.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 2048,
            system:     buildQuickSystem(),
            messages:   [{ role: 'user', content: userContent }]
        });
        return resp.content[0].text.trim();
    } catch (e) {
        console.error(`❌ Error Claude [${telefono}]:`, e.message);
        return 'OK';
    }
}

async function procesarMemoria() {
    resetContadorDiario();
    let rows = [];
    try { rows = memDb.getAllConversaciones(); } catch(e) { return; }

    let cambios = false;
    for (const row of rows) {
        const telefono    = row.mem_key;
        const conversacion = row.historial || '';
        if (!conversacion || typeof conversacion !== 'string') continue;
        const ultimaLong = estadoConv[telefono] || 0;
        if (conversacion.length <= ultimaLong) continue;

        const nuevaParte = conversacion.slice(ultimaLong);
        estadoConv[telefono] = conversacion.length;
        cambios = true;

        // Solo analizar si el bot respondió algo nuevo
        if (!nuevaParte.includes('Bot:')) continue;

        // Contexto previo: últimas 3000 chars antes del cambio (para entender el hilo)
        const inicioContexto = Math.max(0, ultimaLong - 3000);
        const contextoAnterior = conversacion.slice(inicioContexto, ultimaLong).trim();

        // Parte nueva completa (sin filtrar — pasar todo el texto tal cual)
        let nuevasLineas = nuevaParte.trim();
        if (nuevasLineas.length > 6000) nuevasLineas = '...' + nuevasLineas.slice(-6000);

        console.log(`🔍 Analizando ${telefono} (+${nuevaParte.length} chars nuevos)...`);
        const resultado = await analizarIntercambioRapido(telefono, contextoAnterior, nuevasLineas);

        if (resultado === 'OK') { console.log(`  ✅ OK`); continue; }

        let problema;
        try {
            // Claude a veces envuelve el JSON en ```json...``` — limpiar antes de parsear
            const jsonLimpio = resultado.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            problema = JSON.parse(jsonLimpio);
        } catch(e) {
            // Si aun así no es JSON válido, ignorar silenciosamente
            console.warn(`  ⚠️ Respuesta no-JSON descartada para ${telefono}`);
            continue;
        }

        console.log(`  ⚠️ [${problema.severidad}] ${problema.problema}`);
        alertasHoy++;
        encolarAlerta(telefono, problema, nuevasLineas);
    }
    if (cambios) guardarEstado();
}

function encolarAlerta(telefono, problema, intercambio) {
    alertaCounter++;
    const id = `M${alertaCounter}`;
    const emoji = { alta: '🔴', media: '🟡', baja: '🟢' }[problema.severidad] || '⚪';

    const reglaViolada = problema.regla_violada ? `\n📋 *Regla:* _${problema.regla_violada}_\n` : '';

    encolarMensaje(id,
        `🤖 *MONITOR* [${id}]\n` +
        `${emoji} *${(problema.severidad || '').toUpperCase()}* | Cliente: ${telefono}\n\n` +
        `⚠️ *Problema:*\n${problema.problema}\n` +
        reglaViolada +
        `\n💬 *Fragmento:*\n_${problema.fragmento}_\n\n` +
        `💡 *Sugerencia:*\n${problema.sugerencia}\n\n` +
        `─────────────────────\n` +
        `!m si   → aplicar sugerencia\n` +
        `!m no   → ignorar\n` +
        `!m [texto]  → comentar o instruir`
    );
    pendientes.push({ id, tipo: 'alerta', datos: { telefono, problema, intercambio }, timestamp: Date.now() });
    guardarPendientes();
    console.log(`  📤 Alerta encolada: ${id}`);
}

// ── ANÁLISIS PROFUNDO (bucle agéntico con tools) ───────────────────────────────
const SYSTEM_PROFUNDO = `Eres el agente de control de calidad y mejora continua del bot de WhatsApp de Tacos Aragón.
Tienes acceso completo a todas las herramientas del sistema, incluyendo ejecución de shell.

TU PROCESO COMPLETO:
1. Revisa los logs de error recientes: ejecutar_shell("tail -200 logs/error.log")
2. Revisa actividad reciente del bot: ejecutar_shell("tail -150 logs/output.log")
3. Lee las intervenciones humanas recientes (leer_intervenciones) — ¿qué causó que el admin tomara control?
4. Lista las conversaciones activas (listar_conversaciones) e identifica las más largas o problemáticas
5. Para conversaciones sospechosas, léelas (leer_conversacion) y analiza qué falló
6. Si detectas un patrón recurrente, búscalo en todas las conversaciones (buscar_en_conversaciones)
7. Para errores de código, busca en logs: ejecutar_shell("grep -n 'Error\\|❌' logs/error.log | tail -30")
8. Lee el código relevante (leer_archivo) para entender la causa raíz
9. Propón cambios concretos usando proponer_cambio (instrucciones.txt para reglas, index.js para lógica)

REGLAS:
- Siempre empieza por los logs — ahí están los errores reales del sistema
- Solo propón cambios que tengas suficiente evidencia para justificar
- Para instrucciones.txt: agrega reglas claras y específicas
- Para index.js: propón cambios puntuales con buscar/reemplazar exacto
- Prioriza: errores de sistema > intervenciones humanas > confusiones repetidas > mejoras de eficiencia

Al terminar, presenta un resumen ejecutivo (máx 500 chars) de lo que encontraste y qué acciones tomaste.`;

async function realizarAnalisisProfundo(contextoExtra = '') {
    console.log('🔬 Iniciando análisis profundo...');
    encolarMensaje('analisis-inicio', '🔬 *Monitor:* Iniciando análisis profundo... ⏳');
    try {
        const msg = contextoExtra ||
            'Realiza el análisis completo: intervenciones humanas, conversaciones problemáticas y propón mejoras.';
        const resultado = await runAgentLoop(SYSTEM_PROFUNDO, msg);
        if (resultado) {
            encolarMensaje('analisis-fin', `🔬 *ANÁLISIS COMPLETADO*\n\n${resultado}`);
        }
    } catch (e) {
        console.error('❌ Error análisis profundo:', e.message);
        encolarMensaje('analisis-error', `❌ Error en análisis profundo: ${e.message}`);
    }
}

// ── APLICAR SUGERENCIA (alerta) → instrucciones.txt ──────────────────────────
async function aplicarSugerenciaAlerta(pendiente) {
    const { telefono, problema } = pendiente.datos;
    console.log(`🔧 Aplicando sugerencia alerta [${pendiente.id}]...`);
    let instruccionesActuales = '';
    try { instruccionesActuales = fs.readFileSync(INSTRUCCIONES_PATH, 'utf8'); } catch(e) {
        encolarMensaje(`resp-${pendiente.id}`, `❌ No se pudo leer instrucciones.txt: ${e.message}`);
        return;
    }
    try {
        const editResp = await anthropic.messages.create({
            model: 'claude-sonnet-4-6', max_tokens: 512,
            system: `Eres un editor de instrucciones para un bot de WhatsApp de tacos.
Genera UNA SOLA REGLA clara (máx 3 líneas) para añadir al final del archivo de instrucciones del bot.
Solo el texto de la regla, sin explicaciones ni encabezados. En español, específico y accionable.`,
            messages: [{ role: 'user', content: `PROBLEMA: ${problema.problema}\nSUGERENCIA: ${problema.sugerencia}\n\nGenera la regla:` }]
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
    } catch(e) {
        encolarMensaje(`resp-${pendiente.id}`, `❌ Error aplicando sugerencia: ${e.message}`);
    }
}

// ── APLICAR PROPUESTA DE CÓDIGO ───────────────────────────────────────────────
async function aplicarPropuesta(pendiente) {
    const prop = pendiente.datos;
    console.log(`🔧 Aplicando propuesta [${prop.id}] en ${prop.archivo}...`);

    const rutas = {
        'instrucciones.txt':       INSTRUCCIONES_PATH,
        'index.js':                path.join(BASE, 'index.js'),
        'loyverse_integration.js': path.join(BASE, 'loyverse_integration.js')
    };
    const ruta = rutas[prop.archivo];
    if (!ruta || !fs.existsSync(ruta)) {
        encolarMensaje(`resp-${prop.id}`, `❌ Archivo no encontrado: ${prop.archivo}`);
        return;
    }
    try {
        const contenido = fs.readFileSync(ruta, 'utf8');
        fs.writeFileSync(ruta + '.bak', contenido); // backup siempre

        let nuevoContenido;
        if (prop.buscar) {
            if (!contenido.includes(prop.buscar)) {
                encolarMensaje(`resp-${prop.id}`,
                    `❌ No se encontró el texto a reemplazar en ${prop.archivo}.\n` +
                    `Backup guardado: ${prop.archivo}.bak\nRevisa manualmente.`
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
        console.log(`  ✅ ${prop.archivo} actualizado. Backup: ${prop.archivo}.bak`);
    } catch(e) {
        encolarMensaje(`resp-${prop.id}`, `❌ Error aplicando propuesta ${prop.id}: ${e.message}`);
    }
}

// ── INSTRUCCIÓN LIBRE DEL ADMIN ───────────────────────────────────────────────
async function procesarInstruccionAdmin(texto, pendiente) {
    console.log(`  💬 Instrucción admin: "${texto.slice(0, 80)}"`);
    try {
        const contextoDatos = pendiente.tipo === 'alerta'
            ? `PROBLEMA: ${pendiente.datos.problema.problema}\nSUGERENCIA ORIGINAL: ${pendiente.datos.problema.sugerencia}`
            : `PROPUESTA: ${pendiente.datos.descripcion}\nARCHIVO: ${pendiente.datos.archivo}`;

        const resp = await runAgentLoop(
            `Eres el asistente del monitor de calidad del bot de tacos. El admin te envía una instrucción o pregunta.
Responde en español, conciso y útil. Si pide un cambio de código, usa la herramienta proponer_cambio.
Si puedes resolver sin cambios, hazlo directamente. Máximo 6 líneas en tu respuesta final.`,
            `${contextoDatos}\n\nMENSAJE DEL ADMIN: ${texto}`
        );
        encolarMensaje(`resp-${pendiente.id}`, `🤖 *Monitor* [${pendiente.id}]\n\n${resp}`);
    } catch(e) {
        encolarMensaje(`resp-${pendiente.id}`, `❌ Error: ${e.message}`);
    }
}

// ── CONVERSACIÓN LIBRE CON EL ADMIN (sin alerta previa) ──────────────────────
const SYSTEM_CONV_LIBRE = `Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.
El administrador del restaurante te habla directamente. Responde en español, de forma concisa y útil.
El negocio abre martes–domingo, 6 PM–11:30 PM, zona horaria GMT-7. Cierra los lunes.

## Reglas de respuesta
- Montos siempre en pesos MXN. Redondea a 2 decimales.
- "esta semana" = martes más reciente 00:00 GMT-7 hasta ahora → usa periodo=semana
- "hoy" → periodo=hoy | "ayer" → periodo=ayer | "este mes" → periodo=mes
- Si el admin pide un promedio, calcula tú mismo dividiendo total/días o total/pedidos.
- Responde directo con los números; no expliques qué endpoint usaste.

## Para VENTAS, DINERO, ESTADÍSTICAS → consultar_api

### Endpoint principal (úsalo para la mayoría de preguntas de ventas):
  /api/ventas/resumen?periodo=PERIODO
  Retorna: total, pedidos, ticketPromedio, porPago (nombres legibles), porCanal (domicilio/presencial/recoger), topProductos, reembolsos

### Otros endpoints según la pregunta:
  /api/ventas/empleados-ventas?periodo=PERIODO  → quién vendió más, ventas por empleado
  /api/ventas/por-producto?nombre=X&periodo=PERIODO → cuánto dinero/cantidad de un producto (domicilio, asada, adobada, etc.)
  /api/ventas/grafica?periodo=PERIODO&agrupar=hora   → a qué hora se vende más
  /api/ventas/grafica?periodo=PERIODO&agrupar=dia    → cuál fue el mejor día
  /api/dashboard                                      → resumen completo hoy+semana+mes+gráficas
  /api/ventas/ticket/NUMERO                          → detalle de un ticket específico
  /api/ventas/cierres?periodo=PERIODO                → cierres de caja: apertura/cierre, quién abrió/cerró,
                                                        caja_inicial, efectivo_esperado, efectivo_real, diferencia,
                                                        ventas_netas, descuentos, entradas, salidas, movimientos_caja

### Ejemplos rápidos:
  "¿cuánto vendimos hoy?"          → /api/ventas/resumen?periodo=hoy
  "¿cuánto esta semana?"           → /api/ventas/resumen?periodo=semana
  "¿cuánto ayer?"                  → /api/ventas/resumen?periodo=ayer
  "¿cuánto este mes?"              → /api/ventas/resumen?periodo=mes
  "¿cuánto en efectivo/tarjeta?"   → /api/ventas/resumen?periodo=semana  (porPago viene con nombres)
  "¿cuánto de domicilio/envíos?"   → /api/ventas/por-producto?nombre=domicilio&periodo=semana
  "¿cuántos domicilios tuvimos?"   → /api/ventas/resumen?periodo=semana  (porCanal.domicilio)
  "¿quién vendió más?"             → /api/ventas/empleados-ventas?periodo=semana
  "¿a qué hora vendemos más?"      → /api/ventas/grafica?periodo=semana&agrupar=hora
  "¿cuál fue el mejor día?"        → /api/ventas/grafica?periodo=semana&agrupar=dia
  "¿cuántos tacos de asada?"       → /api/ventas/por-producto?nombre=asada&periodo=semana
  "ticket promedio"                → campo ticketPromedio en /api/ventas/resumen
  "¿cuántos reembolsos?"           → campo reembolsos en /api/ventas/resumen
  "¿cuánto había en caja?"         → /api/ventas/cierres?periodo=hoy
  "¿hubo diferencia de caja?"      → /api/ventas/cierres?periodo=semana  (campo diferencia)
  "¿a qué hora abrieron la caja?"  → /api/ventas/cierres?periodo=hoy  (campo apertura)
  "¿quién cerró la caja?"          → /api/ventas/cierres?periodo=hoy  (campo cerrado_por)

⛔ NUNCA uses ejecutar_shell para buscar ventas — los logs de PM2 no tienen esa información.

## Para GRÁFICAS o AUDIO → enviar_media
Úsalo cuando el admin pida "gráfica", "chart", "imagen", "visualización", "por voz", "audio", "dímelo en voz".

Flujo estándar para gráfica de ventas:
  1. consultar_api → /api/ventas/grafica?periodo=semana&agrupar=dia  (obtiene labels y valores)
  2. enviar_media  → tipo=grafica, datos_grafica={titulo, labels, valores, tipo_grafica}
  3. Responde con resumen de texto del mismo dato

Ejemplos de datos_grafica:
  Ventas por día:       {titulo:"Ventas esta semana", labels:["Mar","Mié","Jue","Vie","Sáb","Dom"], valores:[...], tipo_grafica:"bar"}
  Tendencia mensual:    {tipo_grafica:"line", ...}
  Top productos:        {tipo_grafica:"horizontalBar", labelDataset:"Unidades vendidas", ...}
  Por canal:            {titulo:"Pedidos por canal", labels:["domicilio","llevar","comer aqui"], valores:[38,34,27], tipo_grafica:"bar"}

Flujo para audio:
  1. (opcional) consultar_api para obtener los datos
  2. Redacta un texto conciso en español (máx 200 chars): "Esta semana vendimos $24,492. 114 pedidos. Ticket promedio $214."
  3. enviar_media → tipo=audio, texto_voz="..."

## Para ESTADO DEL PROCESO, ERRORES o LOGS → ejecutar_shell
  pm2 status
  pm2 logs TacosAragon --lines 30 --nostream
  grep -i "error" logs/error.log | tail -20

## Para CONVERSACIONES DE CLIENTES → leer_conversacion, listar_conversaciones, buscar_en_conversaciones
## Para CÓDIGO O REGLAS DEL BOT → leer_archivo
## Para PROPONER MEJORAS → proponer_cambio`;

// Historial de conversación libre en memoria (por sesión del proceso)
const convLibreHistorial = []; // [{ role, content }]

async function procesarConversacionLibre(convId, texto) {
    console.log(`💬 Conversación libre: "${texto.slice(0, 80)}"`);
    try {
        convLibreHistorial.push({ role: 'user', content: texto });

        // Mantener historial manejable (últimos 20 turnos)
        if (convLibreHistorial.length > 40) convLibreHistorial.splice(0, 2);

        const messages = [...convLibreHistorial];
        let iter = 0;
        const MAX_ITER = 10;

        while (iter++ < MAX_ITER) {
            const response = await anthropic.messages.create({
                model:      'claude-sonnet-4-6',
                max_tokens: 2048,
                system:     SYSTEM_CONV_LIBRE,
                tools:      TOOLS,
                messages
            });

            if (response.stop_reason === 'end_turn') {
                const textBlock = response.content.find(c => c.type === 'text');
                const respuesta = textBlock?.text || '';
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
    } catch(e) {
        console.error('❌ Error conversación libre:', e.message);
        encolarMensaje(`conv-resp-${convId}`, `❌ Error: ${e.message}`);
    }
}

// ── COMANDOS ESPECIALES DEL ADMIN ─────────────────────────────────────────────
async function procesarComandoAdmin(cmd) {
    switch (cmd.toLowerCase()) {

        case 'reporte':
            realizarAnalisisProfundo().catch(console.error);
            break;

        case 'estado': {
            resetContadorDiario();
            const numConvs  = (() => { try { return memDb.countConversaciones(); } catch(e) { return '?'; }})();
            const numInterv = (() => { try { return JSON.parse(fs.readFileSync(INTERV_PATH, 'utf8')).length; } catch(e) { return 0; }})();
            const propPend  = pendientes.filter(p => p.tipo === 'propuesta').length;
            const alertPend = pendientes.filter(p => p.tipo === 'alerta').length;
            encolarMensaje('estado',
                `🤖 *Estado del Monitor*\n\n` +
                `📊 Conversaciones vigiladas: ${numConvs}\n` +
                `⚠️ Alertas hoy: ${alertasHoy}\n` +
                `🚨 Intervenciones totales: ${numInterv}\n` +
                `🔧 Propuestas pendientes: ${propPend}\n` +
                `🔔 Alertas pendientes: ${alertPend}\n` +
                `🤖 Modelo: claude-sonnet-4-6`
            );
            break;
        }

        case 'propuestas': {
            const props = pendientes.filter(p => p.tipo === 'propuesta');
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
            // Verificar que el orquestador no esté en medio de una recuperación activa
            const ORCH_DB_PATH = process.env.ORCH_DB_PATH;
            if (ORCH_DB_PATH) {
                try {
                    const Database = require('better-sqlite3');
                    const orchDb = new Database(ORCH_DB_PATH, { readonly: true });
                    const falla = orchDb.prepare(
                        `SELECT en_cooldown FROM fallas WHERE servicio = 'TacosAragon' LIMIT 1`
                    ).get();
                    orchDb.close();
                    if (falla && falla.en_cooldown === 1) {
                        encolarMensaje('cmd-reiniciar-bloq',
                            '⚠️ *Monitor:* Reinicio bloqueado — el orquestador ya está ejecutando una recuperación de TacosAragon. Espera a que termine.'
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
                encolarMensaje('cmd-reiniciar-ok', '✅ *Monitor:* `pm2 restart TacosAragon` ejecutado. Verificando conexión en 90s...');
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

// ── PROCESAMIENTO DE RESPUESTAS DEL ADMIN ────────────────────────────────────
let procesandoRespuestas = false; // Guard anti-reentrancia

async function procesarRespuestas() {
    if (procesandoRespuestas) return; // Evitar solapamiento entre ciclos
    const responses = mensajesDb.leerResponsesPendientes();
    if (!responses.length) return;

    procesandoRespuestas = true;

    try {
        for (const resp of responses) {
            try {
                // Comandos especiales (id empieza con 'cmd-')
                if (resp.id.startsWith('cmd-')) {
                    await procesarComandoAdmin(resp.texto);
                    mensajesDb.marcarResponseProcesada(resp.rowid);
                    continue;
                }

                // Conversación libre (id empieza con 'conv-') — sin alerta pendiente
                if (resp.id.startsWith('conv-')) {
                    await procesarConversacionLibre(resp.id, resp.texto);
                    mensajesDb.marcarResponseProcesada(resp.rowid);
                    continue;
                }

                // Las propuestas se encolan con id 'propuesta-P1' pero el pendiente usa 'P1'
                const lookupId = resp.id.startsWith('propuesta-') ? resp.id.slice('propuesta-'.length) : resp.id;
                const pendiente = pendientes.find(p => p.id === lookupId);
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

                pendientes = pendientes.filter(p => p.id !== lookupId);
                guardarPendientes();
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

// ── VERIFICACIÓN POST-REINICIO DE TACOS ARAGÓN ───────────────────────────────
let tacosRestartCount = -1; // -1 = no inicializado aún

async function verificarConexionWhatsApp(restartNum) {
    console.log(`🔍 Verificando conexión WhatsApp post-reinicio #${restartNum}...`);
    try {
        const resumen = await runAgentLoop(
            `Eres el monitor del bot de Tacos Aragón. El proceso TacosAragon acaba de reiniciarse.
Tu tarea: verificar si WhatsApp se conectó correctamente siguiendo estos pasos:

1. Verifica el estado actual del proceso:
   ejecutar_shell("pm2 status")

2. Lee los logs recientes del bot:
   ejecutar_shell("pm2 logs TacosAragon --lines 60 --nostream")

3. Busca en los logs la señal de arranque exitoso:
   La frase clave es: "✅ SISTEMA ACTIVO (Memoria Extendida)"
   También busca errores como: "Chrome", "Session", "Auth", "❌", "timeout"

4. Si el bot NO se conectó (no aparece la frase clave o hay errores):
   - Ejecuta: ejecutar_shell("tail -50 logs/error.log")
   - Diagnostica qué falló
   - La secuencia correcta de reinicio es:
     a) pm2 stop TacosAragon
     b) Cerrar todos los procesos chrome.exe
     c) Borrar: C:/SesionBot/SingletonLock, SingletonCookie, SingletonSocket, DevToolsActivePort
     d) pm2 start TacosAragon

Responde en máximo 300 chars con: "✅ Bot conectado [detalles]" o "❌ Bot NO conectado — [diagnóstico y pasos sugeridos]"`,
            `Verificar arranque de TacosAragon reinicio #${restartNum}`
        );

        const exito = resumen && /SISTEMA ACTIVO|conectado|ready|✅/i.test(resumen);
        const emoji = exito ? '✅' : '🔴';

        encolarMensaje(`verificacion-${restartNum}`,
            `${emoji} *Verificación post-reinicio #${restartNum}*\n\n${resumen || 'No se pudo obtener resultado.'}`
        );
        console.log(`  ${emoji} Resultado verificación #${restartNum}: ${(resumen || '').slice(0, 80)}`);
    } catch(e) {
        console.error('❌ verificarConexionWhatsApp:', e.message);
        encolarMensaje(`verificacion-err-${restartNum}`,
            `❌ *Error al verificar arranque #${restartNum}:*\n${e.message}`
        );
    }
}

async function checkTacosAragonRestarts() {
    try {
        const salidaJson = execSync('pm2 jlist', {
            cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true
        });
        const procs = JSON.parse(salidaJson);
        const tacos = procs.find(p => p.name === 'TacosAragon');
        if (!tacos) return;

        const restarts = tacos.pm2_env.restart_time || 0;

        if (tacosRestartCount === -1) {
            // Primera lectura — solo registrar el valor base
            tacosRestartCount = restarts;
            console.log(`   TacosAragon restarts base: ${restarts}`);
            return;
        }

        if (restarts > tacosRestartCount) {
            console.log(`🔄 TacosAragon reiniciado (restart #${restarts}) — verificando en 90s...`);
            tacosRestartCount = restarts;
            // Esperar 90s para que Chrome/WhatsApp arranquen completamente
            setTimeout(() => verificarConexionWhatsApp(restarts).catch(console.error), 90000);
        }
    } catch(e) {
        // pm2 jlist puede fallar si PM2 no está disponible — ignorar silenciosamente
    }
}

// ── MONITOR DE LOGS DE ERROR ──────────────────────────────────────────────────
// Detecta errores nuevos en logs/error.log y lanza análisis agéntico automático
async function procesarLogsError() {
    if (!fs.existsSync(ERROR_LOG)) return;
    try {
        const stat = fs.statSync(ERROR_LOG);
        const tamActual = stat.size;
        if (tamActual <= estadoLogs.errorLogSize) return; // nada nuevo

        // Leer solo la parte nueva
        const fd = fs.openSync(ERROR_LOG, 'r');
        const nuevosBytes = tamActual - estadoLogs.errorLogSize;
        const buf = Buffer.alloc(Math.min(nuevosBytes, 8000)); // máx 8 KB nuevos
        const offset = Math.max(0, tamActual - 8000);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        estadoLogs.errorLogSize = tamActual;

        const nuevoTexto = buf.toString('utf8').trim();
        if (!nuevoTexto) return;

        // Filtrar líneas vacías o puramente informativas
        const lineasError = nuevoTexto.split('\n').filter(l =>
            /error|Error|ERROR|exception|Exception|TypeError|ReferenceError|❌|crash|FATAL|unhandled/i.test(l)
        );
        if (!lineasError.length) return;

        console.log(`🔴 Nuevos errores en logs (${lineasError.length} líneas) — analizando...`);

        // Análisis agéntico: el modelo puede ejecutar shell para más contexto
        const resumen = await runAgentLoop(
            `Eres el monitor de calidad del bot de Tacos Aragón. Se detectaron errores nuevos en los logs.
Analiza los errores, determina su causa raíz y propón una solución concreta.
Si el error es recurrente, usa buscar_en_conversaciones para ver si afectó a clientes.
Si necesitas más contexto del log, usa ejecutar_shell (ej: tail -100 logs/error.log).
Si detectas que es un bug de código, usa proponer_cambio.
Respuesta final: resumen ejecutivo breve (máx 300 chars) para el admin.`,
            `ERRORES NUEVOS EN logs/error.log:\n${lineasError.slice(-50).join('\n')}`
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

// ── INICIALIZACIÓN ────────────────────────────────────────────────────────────

// Inicializar tamaño actual de logs (no analizar todo el historial al arrancar)
try { estadoLogs.errorLogSize  = fs.statSync(ERROR_LOG).size;  } catch(e) {}
try { estadoLogs.outputLogSize = fs.statSync(OUTPUT_LOG).size; } catch(e) {}

console.log('🤖 Agente Monitor iniciado');
console.log(`   Modelo: claude-sonnet-4-6 (tool use habilitado)`);
console.log(`   Estado previo: ${Object.keys(estadoConv).length} conversaciones analizadas`);
console.log(`   Tools disponibles: ${TOOLS.map(t => t.name).join(', ')}`);

// Polling sobre la DB SQLite cada 5s (fs.watch no es confiable con SQLite WAL en Windows)
setInterval(procesarMemoria, 5000);
console.log('   Watch conversaciones: polling SQLite cada 5s');

// Watch error.log con debounce
let debounceLog = null;
try {
    fs.watch(ERROR_LOG, (eventType) => {
        if (eventType !== 'change') return;
        if (debounceLog) clearTimeout(debounceLog);
        debounceLog = setTimeout(procesarLogsError, 4000); // 4s de debounce (errores pueden llegar en ráfaga)
    });
    console.log('   Watch error.log: activo');
} catch (e) {
    // Si no existe el archivo aún, polling cada 2 minutos
    console.warn('   Watch error.log falló, polling 2min:', e.message);
    setInterval(procesarLogsError, 120000);
}

// Poll de respuestas del admin cada 5 segundos
setInterval(procesarRespuestas, 5000);

// Verificación de reinicios de TacosAragon cada 30 segundos
setTimeout(checkTacosAragonRestarts, 8000);       // lectura base inicial
setInterval(checkTacosAragonRestarts, 30000);      // polling continuo

// Revisión periódica de logs de arranque cada 30 minutos
setInterval(async () => {
    try {
        const salidaJson = execSync('pm2 jlist', { cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true });
        const procs = JSON.parse(salidaJson);
        const tacos = procs.find(p => p.name === 'TacosAragon');
        if (!tacos) {
            encolarMensaje('salud-' + Date.now(), '🔴 *ALERTA:* TacosAragon no aparece en PM2.');
            return;
        }
        const estado = tacos.pm2_env.status; // online | stopped | errored
        const uptime = tacos.pm2_env.pm_uptime;
        const uptimeMin = uptime ? Math.floor((Date.now() - uptime) / 60000) : 0;

        // Leer las últimas 80 líneas del log de TacosAragon (pm2 logs usa el path correcto)
        let ultimasLineas = '';
        try {
            ultimasLineas = execSync('pm2 logs TacosAragon --lines 80 --nostream', { cwd: BASE, timeout: 8000, encoding: 'utf8', shell: true, windowsHide: true });
        } catch(e) { ultimasLineas = ''; }

        const sistemaActivo = ultimasLineas.includes('SISTEMA ACTIVO');
        const hayActividad  = /Bot:|Cliente:|Loyverse|ORDEN CONFIRMADA/i.test(ultimasLineas);
        const hayErrores    = /❌|Error|timeout|desconectado/i.test(ultimasLineas);

        let icono, mensaje;
        if (estado !== 'online') {
            icono = '🔴';
            mensaje = `TacosAragon en estado: *${estado}*. Revisar urgente.`;
        } else if (!sistemaActivo && uptimeMin < 60) {
            icono = '🟡';
            mensaje = `Proceso online pero sin señal "SISTEMA ACTIVO" en logs (${uptimeMin} min activo).`;
        } else if (hayErrores && !hayActividad) {
            icono = '🟡';
            mensaje = `Proceso online pero con errores recientes y sin actividad de clientes.`;
        } else {
            icono = '✅';
            mensaje = `TacosAragon OK | uptime: ${uptimeMin} min | ${hayActividad ? 'con actividad reciente' : 'sin mensajes recientes'}`;
        }

        console.log(`⏱️ Revisión 30min: ${icono} ${mensaje}`);
        // Solo mandar alerta al admin si hay problema — el OK solo queda en el log local
        if (icono !== '✅') {
            encolarMensaje('salud-' + Date.now(), `${icono} *Revisión periódica TacosAragon*\n\n${mensaje}`);
        }
    } catch(e) {
        console.error('❌ Revisión periódica:', e.message);
    }
}, 30 * 60 * 1000);

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
        console.log('🧹 Cola limpiada (mensajes enviados > 1h eliminados)');
    } catch (e) {
        console.error('[monitor] Error en limpieza de cola:', e.message);
    }
}, 3600000);

process.on('SIGINT',  () => { guardarEstado(); process.exit(0); });
process.on('SIGTERM', () => { guardarEstado(); process.exit(0); });
process.on('uncaughtException',  (err) => console.error('💀 Monitor error:', err.message));
process.on('unhandledRejection', (r)   => console.error('💀 Monitor rejection:', r));
