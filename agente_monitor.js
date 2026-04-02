'use strict';
// ─── AGENTE MONITOR DE CALIDAD — Tacos Aragón ────────────────────────────────
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
const { ejecutarRapido, ejecutarProfundo } = require('./claude-runner');

// ── RUTAS ─────────────────────────────────────────────────────────────────────
const BASE              = path.join(__dirname, '..');
const DATOS             = path.join(BASE, 'datos');
const INSTRUCCIONES_PATH= path.join(DATOS, 'instrucciones.txt');
const REGLAS_MON_PATH   = path.join(DATOS, 'reglas_monitor.txt');
const MENU_PATH         = path.join(DATOS, 'menu.csv');
const NO_DISP_PATH      = path.join(DATOS, 'no_disponible.txt');
const LOY_CONFIG_PATH   = path.join(DATOS, 'loyverse_config.json');
const memDb             = require('../datos/memoria_db');
const mensajesDb        = require('../datos/mensajes_db');
const INTERV_PATH       = path.join(DATOS, 'intervenciones_humanas.json');
const ESTADO_PATH       = path.join(DATOS, 'agente_estado.json');
const PENDIENTES_PATH   = path.join(DATOS, 'agente_pendientes.json');
const LOGS_DIR          = path.join(BASE, 'logs');
const ERROR_LOG         = path.join(LOGS_DIR, 'error.log');
const OUTPUT_LOG        = path.join(LOGS_DIR, 'output.log');
const CHANGELOG_FILE    = path.join(process.env.SESSION_DIR || '/data/session', 'changelogs', 'MonitorBot.jsonl');

// ── API KEY — eliminado: usa claude -p (plan Max, sin API key) ───────────────

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

// Restaurar pendientes del disco para que los botones de Telegram funcionen tras reinicios
try {
    if (fs.existsSync(PENDIENTES_PATH)) {
        pendientes = JSON.parse(fs.readFileSync(PENDIENTES_PATH, 'utf8'));
        for (const p of pendientes) {
            const id = p.datos?.id || p.id || '';
            if (id.startsWith('P')) {
                const n = parseInt(id.slice(1), 10);
                if (!isNaN(n) && n > propuestaCounter) propuestaCounter = n;
            } else if (id.startsWith('M')) {
                const n = parseInt(id.slice(1), 10);
                if (!isNaN(n) && n > alertaCounter) alertaCounter = n;
            }
        }
    }
} catch (e) { pendientes = []; }

function guardarEstado() {
    try { fs.writeFileSync(ESTADO_PATH, JSON.stringify(estadoConv, null, 2)); } catch (e) {}
}

function guardarPendientes() {
    try { fs.writeFileSync(PENDIENTES_PATH, JSON.stringify(pendientes, null, 2)); } catch (e) {}
}

function logCambio({ titulo, desc = '', archivos = [], tags = [], origen = 'user' }) {
    try {
        const entry = { ts: new Date().toISOString(), agente: 'MonitorBot', origen, titulo, desc, archivos, tags };
        fs.mkdirSync(path.dirname(CHANGELOG_FILE), { recursive: true });
        fs.appendFileSync(CHANGELOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
        console.warn('⚠️ logCambio error:', e.message);
    }
}

// ── LLAMADA HTTP A LA API CENTRAL ─────────────────────────────────────────────
function llamarApi(apiPath) {
    const API_URL   = process.env.TACOS_API_URL   || 'http://tacos-api:3001';
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

// ── COLA / RESPUESTAS (SQLite compartida — sin race conditions) ───────────────
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
                    `🔧 *PROPUESTA DE CÓDIGO* (${id})\n` +
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

// ── BUCLE AGÉNTICO → claude -p con MCP project-tacos-bot ─────────────────────
//
// Reemplaza la integración directa con Anthropic SDK.
// Claude usa las herramientas MCP del servidor para leer archivos, ejecutar
// comandos, ver logs y git. Las propuestas de código se devuelven como bloques
// PROPUESTA_CAMBIO...FIN_PROPUESTA en el texto de salida.

async function runAgentLoop(systemPrompt, userMessage) {
    const resultado = await ejecutarProfundo(systemPrompt, userMessage, 300_000);
    return resultado.output || 'Análisis completado.';
}

// ── Parser de propuestas de código en el output de Claude ─────────────────────
//
// Claude incluye bloques estructurados en su respuesta cuando quiere proponer
// cambios. Este parser los extrae y crea entradas en `pendientes`.
//
// Formato esperado en el output:
//   PROPUESTA_CAMBIO
//   archivo: instrucciones.txt
//   descripcion: Añadir regla sobre X
//   buscar: (texto exacto a reemplazar, vacío si añadir al final)
//   reemplazar: (nuevo texto)
//   FIN_PROPUESTA

function parsearYEncolarPropuestas(outputText) {
    const regex = /PROPUESTA_CAMBIO\n([\s\S]*?)FIN_PROPUESTA/g;
    let match;
    while ((match = regex.exec(outputText)) !== null) {
        try {
            const bloque = match[1];
            const get = (campo) => {
                const m = bloque.match(new RegExp(`^${campo}:\\s*(.*)`, 'm'));
                return m ? m[1].trim() : '';
            };
            // Para campos multilínea (buscar / reemplazar), tomar desde la etiqueta hasta la siguiente
            const getMultilinea = (campo, siguiente) => {
                const pattern = new RegExp(`^${campo}:\\s*([\\s\\S]*?)(?=^${siguiente}:|$)`, 'm');
                const m = bloque.match(pattern);
                return m ? m[1].trim() : '';
            };

            const archivo     = get('archivo');
            const descripcion = get('descripcion');
            const buscar      = getMultilinea('buscar', 'reemplazar');
            const reemplazar  = getMultilinea('reemplazar', 'FIN_PROPUESTA');

            if (!archivo || !descripcion || !reemplazar) continue;

            propuestaCounter++;
            const id = `P${propuestaCounter}`;
            const esJs = archivo.endsWith('.js');
            const propuesta = {
                id, archivo, descripcion,
                buscar: buscar || '',
                reemplazar,
                timestamp: Date.now(), aplicada: false
            };

            pendientes.push({ id, tipo: 'propuesta', datos: propuesta, timestamp: Date.now() });
            guardarPendientes();

            const preview = buscar
                ? `🔴 _Reemplazar:_\n\`${buscar.slice(0, 180)}\`\n\n🟢 _Con:_\n\`${reemplazar.slice(0, 180)}\``
                : `🟢 _Añadir al final:_\n\`${reemplazar.slice(0, 300)}\``;

            encolarMensaje(
                `propuesta-${id}`,
                `🔧 *PROPUESTA DE CÓDIGO* (${id})\n` +
                `📄 Archivo: \`${archivo}\`\n\n` +
                `💡 ${descripcion}\n\n` +
                `${preview}\n\n` +
                (esJs ? `⚠️ _Se hará backup automático antes de aplicar_\n\n` : '') +
                `!m si  →  aplicar\n!m no  →  rechazar`
            );
            console.log(`  📤 Propuesta [${id}] encolada desde output de Claude`);
        } catch (e) {
            console.warn(`  ⚠️ Error parseando bloque PROPUESTA_CAMBIO:`, e.message);
        }
    }
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

    return `<sistema>
<identidad>Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.</identidad>

<tarea>
Recibirás el historial reciente de una conversación y los mensajes nuevos a evaluar.
Tu trabajo: detectar errores REALES y CONCRETOS del bot. Sé preciso, no reportes falsos positivos.
</tarea>

<instrucciones_bot>
${instrucciones}
</instrucciones_bot>

<menu_vigente formato="CSV">
${menuLineas}
</menu_vigente>
${noDisp ? `\n<no_disponibles>⛔ No sugerir ni confirmar nunca:\n${noDisp}\n</no_disponibles>\n` : ''}
<detectar>
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
</detectar>

<criterio>
Usa el historial reciente como contexto para entender la conversación completa.
Evalúa los mensajes nuevos a la luz del historial — no los juzgues fuera de contexto.
</criterio>

<formato_respuesta>
Si todo está bien → responde SOLO la palabra: OK
Si hay problema → responde SOLO JSON (sin markdown, sin bloques de código, JSON puro):
{"problema":"qué hizo mal el bot (específico)","severidad":"alta|media|baja","fragmento":"cita literal del texto erróneo (máx 250 chars)","sugerencia":"corrección concreta y accionable","regla_violada":"qué regla de las instrucciones se incumplió"}
</formato_respuesta>
</sistema>`;
}

async function analizarIntercambioRapido(telefono, contextoCompleto, nuevasLineas) {
    try {
        const system = buildQuickSystem();
        const user   =
            `<evaluacion cliente="${telefono}">\n` +
            `<historial_reciente>\n${contextoCompleto}\n</historial_reciente>\n\n` +
            `<mensajes_nuevos>\n${nuevasLineas}\n</mensajes_nuevos>\n</evaluacion>`;
        const fullPrompt = `${system}\n\n${user}`;
        return (await ejecutarRapido(fullPrompt, 60_000)).trim() || 'OK';
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

// ── ANÁLISIS PROFUNDO (claude -p + MCP project-tacos-bot) ────────────────────
const SYSTEM_PROFUNDO = `<sistema>
<identidad>
Eres el agente de control de calidad y mejora continua del bot de WhatsApp de Tacos Aragón.
Tienes acceso completo al proyecto bot-tacos via herramientas MCP: read_file, edit_file, write_file,
search_code, list_files, run_command, view_logs, git_status, git_diff, restart_process, run_tests.
</identidad>

<proceso>
1. Revisa logs recientes del bot: view_logs(lines=200)
2. Revisa logs de error: run_command("tail -200 logs/error.log")
3. Lee intervenciones humanas recientes: read_file(path="datos/intervenciones_humanas.json")
4. Lista conversaciones activas: list_files(path="datos/") — identifica archivos grandes
5. Para conversaciones sospechosas: read_file(path="datos/conversaciones/TELEFONO.txt") o search_code
6. Si detectas patrón recurrente: search_code(pattern="texto_buscado", glob="datos/**")
7. Para errores de código: search_code(pattern="Error|❌", glob="logs/error.log")
8. Lee el código relevante: read_file(path="index.js") o read_file(path="datos/instrucciones.txt")
9. Para datos de ventas: run_command con curl a la API local:
   run_command("curl -s -H \\"x-api-token: SCRUBBED_TACOS_API_TOKEN\\" http://tacos-api:3001/api/ventas/resumen?periodo=hoy")
</proceso>

<proponer_cambios>
Si identificas un cambio necesario en instrucciones.txt o index.js, inclúyelo en tu respuesta
con este formato EXACTO (el sistema lo parsea automáticamente):

PROPUESTA_CAMBIO
archivo: instrucciones.txt
descripcion: Añadir regla sobre X porque Y
buscar: (texto exacto a reemplazar — dejar vacío si añadir al final)
reemplazar: (nuevo texto o regla nueva)
FIN_PROPUESTA
</proponer_cambios>

<reglas>
- Siempre empieza por view_logs — ahí están los errores reales del sistema
- Solo propón cambios con evidencia suficiente en los logs/conversaciones
- Para instrucciones.txt: reglas claras y específicas
- Para index.js: cambios puntuales con buscar/reemplazar exacto
- Prioriza: errores de sistema > intervenciones humanas > confusiones repetidas > mejoras de eficiencia
</reglas>

<salida>Al terminar, presenta un resumen ejecutivo (máx 500 chars) de lo que encontraste y qué acciones tomaste.</salida>

<historial_cambios obligatorio="true">
Si aplicaste algún cambio de código (edit_file, write_file), llama a log_change como ÚLTIMO paso:
- titulo: frase concisa del cambio
- desc: qué cambió y por qué
- archivos: archivos modificados
- tags: del vocabulario: bug, feature, config, prompt, api, db, telegram, monitor, tacos-bot
- origen: "autofix" si fue análisis automático, "user" si fue instrucción directa

Si solo consultaste sin modificar archivos, no es necesario.
</historial_cambios>
</sistema>`;

async function realizarAnalisisProfundo(contextoExtra = '') {
    console.log('🔬 Iniciando análisis profundo...');
    encolarMensaje('analisis-inicio', '🔬 *Monitor:* Iniciando análisis profundo... ⏳');
    try {
        const msg = contextoExtra ||
            'Realiza el análisis completo: intervenciones humanas, conversaciones problemáticas y propón mejoras.';
        const resultado = await runAgentLoop(SYSTEM_PROFUNDO, msg);
        if (resultado) {
            parsearYEncolarPropuestas(resultado);
            // Enviar resumen al admin (sin los bloques de propuesta que ya se procesaron)
            const resumenLimpio = resultado.replace(/PROPUESTA_CAMBIO[\s\S]*?FIN_PROPUESTA/g, '').trim();
            if (resumenLimpio) {
                encolarMensaje('analisis-fin', `🔬 *ANÁLISIS COMPLETADO*\n\n${resumenLimpio}`);
            }
        }
    } catch (e) {
        console.error('❌ Error análisis profundo:', e.message);
        encolarMensaje('analisis-error', `❌ Error en análisis profundo: ${e.message}`);
    }
}

// ── APLICAR SUGERENCIA (alerta) → reglas_monitor.txt ─────────────────────────

/**
 * Detecta a qué sección de instrucciones aplica una regla, según el problema.
 */
function detectarSeccionRegla(problema) {
    const txt = (problema.problema + ' ' + problema.sugerencia).toLowerCase();
    if (/precio|cuenta|total|cobr|pago|transferencia|descuento/.test(txt)) return 'pago';
    if (/domicilio|envío|ubicación|dirección|gps|pin/.test(txt)) return 'entrega';
    if (/salud|bienvenid|carnes|horario/.test(txt)) return 'saludo';
    if (/carne|verdura|ingrediente|combo|menú|pedido|orden|quesadilla|taco/.test(txt)) return 'pedido';
    return 'general';
}

/**
 * Inserta una regla XML dentro de <reglas_activas> en reglas_monitor.txt
 */
function insertarReglaMonitor(id, seccion, textoRegla) {
    let contenido = '';
    try { contenido = fs.readFileSync(REGLAS_MON_PATH, 'utf8'); } catch(e) {
        throw new Error(`No se pudo leer reglas_monitor.txt: ${e.message}`);
    }
    const fecha = new Date().toISOString().slice(0, 10);
    const nuevaRegla = `  <regla id="${id}" seccion="${seccion}" fecha="${fecha}">\n    ${textoRegla}\n  </regla>`;

    // Insertar antes del cierre de </reglas_activas>
    const cierre = '</reglas_activas>';
    if (!contenido.includes(cierre)) {
        throw new Error('reglas_monitor.txt no tiene </reglas_activas>');
    }
    const nuevo = contenido.replace(cierre, nuevaRegla + '\n\n' + cierre);
    fs.writeFileSync(REGLAS_MON_PATH, nuevo);
}

/**
 * Paso 1: Genera la regla con Claude y la muestra al admin para revisión.
 * No la inserta — queda como pendiente tipo 'regla_preview'.
 */
async function generarPreviewRegla(pendiente) {
    const { telefono, problema } = pendiente.datos;
    console.log(`🔧 Generando preview de regla [${pendiente.id}]...`);
    try {
        const promptRegla =
            `<sistema>\n` +
            `<identidad>Eres un editor de instrucciones para un bot de WhatsApp de tacos.</identidad>\n` +
            `<tarea>Genera UNA SOLA REGLA clara (máx 3 líneas). Solo el texto de la regla, sin explicaciones, sin encabezados, sin tags XML. En español, específico y accionable.</tarea>\n` +
            `<contexto>\n` +
            `<problema>${problema.problema}</problema>\n` +
            `<sugerencia>${problema.sugerencia}</sugerencia>\n` +
            `</contexto>\n` +
            `</sistema>\n\nGenera la regla:`;
        const nuevaRegla = (await ejecutarRapido(promptRegla, 30_000)).trim();
        const seccion = detectarSeccionRegla(problema);

        // Guardar regla generada en el pendiente para el paso 2
        pendiente.datos.regla_generada = nuevaRegla;
        pendiente.datos.seccion_regla = seccion;
        pendiente.tipo = 'regla_preview';
        guardarPendientes();

        encolarMensaje(`resp-${pendiente.id}`,
            `📝 *Regla propuesta* [${pendiente.id}]\n\n` +
            `📂 Sección: *${seccion}*\n` +
            `📋 Regla:\n_${nuevaRegla}_\n\n` +
            `─────────────────────\n` +
            `!m si   → aplicar regla\n` +
            `!m no   → descartar\n` +
            `!m [texto] → corregir`
        );
        console.log(`  📝 Preview enviada [${seccion}]`);
    } catch(e) {
        encolarMensaje(`resp-${pendiente.id}`, `❌ Error generando regla: ${e.message}`);
    }
}

/**
 * Paso 2: El admin aprobó la regla previamente mostrada. Ahora sí insertar.
 */
async function aplicarReglaAprobada(pendiente) {
    const { regla_generada, seccion_regla } = pendiente.datos;
    console.log(`🔧 Aplicando regla aprobada [${pendiente.id}] → ${seccion_regla}...`);
    try {
        insertarReglaMonitor(pendiente.id, seccion_regla, regla_generada);
        logCambio({
            titulo:   `Alerta ${pendiente.id}: regla añadida a reglas_monitor.txt`,
            desc:     `Sección: ${seccion_regla} | Regla: ${regla_generada.slice(0, 120)}`,
            archivos: ['reglas_monitor.txt'],
            tags:     ['monitor', 'prompt'],
            origen:   'user',
        });
        encolarMensaje(`resp-${pendiente.id}`,
            `✅ *Regla aplicada* [${pendiente.id}] (${seccion_regla})\n\n` +
            `El bot la aplica automáticamente en el siguiente mensaje.`
        );
        console.log(`  ✅ reglas_monitor.txt actualizado [${seccion_regla}]`);
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
        logCambio({
            titulo:   `Propuesta ${prop.id}: ${prop.descripcion.slice(0, 80)}`,
            desc:     prop.descripcion,
            archivos: [prop.archivo],
            tags:     ['monitor', prop.archivo.endsWith('.js') ? 'code' : 'prompt'],
            origen:   'user',
        });

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
            `<sistema>
<identidad>Eres el asistente del monitor de calidad del bot de tacos.</identidad>
<tarea>El admin te envía una instrucción o pregunta. Responde en español, conciso y útil. Si pide un cambio de código, usa la herramienta proponer_cambio. Si puedes resolver sin cambios, hazlo directamente.</tarea>
<formato>Máximo 6 líneas en tu respuesta final.</formato>
</sistema>`,
            `<contexto>\n${contextoDatos}\n</contexto>\n\n<mensaje_admin>${texto}</mensaje_admin>`
        );
        encolarMensaje(`resp-${pendiente.id}`, `🤖 *Monitor* [${pendiente.id}]\n\n${resp}`);
    } catch(e) {
        encolarMensaje(`resp-${pendiente.id}`, `❌ Error: ${e.message}`);
    }
}

// ── CONVERSACIÓN LIBRE CON EL ADMIN (sin alerta previa) ──────────────────────
const SYSTEM_CONV_LIBRE = `<sistema>
<identidad>
Eres el agente de control de calidad del bot de WhatsApp de Tacos Aragón.
El administrador del restaurante te habla directamente. Responde en español, de forma concisa y útil.
</identidad>

<contexto_negocio>
Horario: martes–domingo, 6 PM–11:30 PM, zona horaria GMT-7. Cierra los lunes.
</contexto_negocio>

<reglas_respuesta>
- Montos siempre en pesos MXN. Redondea a 2 decimales.
- "esta semana" = martes más reciente 00:00 GMT-7 hasta ahora → usa periodo=semana
- "hoy" → periodo=hoy | "ayer" → periodo=ayer | "este mes" → periodo=mes
- Si el admin pide un promedio, calcula tú mismo dividiendo total/días o total/pedidos.
- Responde directo con los números; no expliques qué endpoint usaste.
</reglas_respuesta>

<tools_ventas>
Para VENTAS, DINERO, ESTADÍSTICAS → run_command con curl a la API local.

Token: SCRUBBED_TACOS_API_TOKEN
Base URL: http://tacos-api:3001

Comandos curl útiles:
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/resumen?periodo=hoy")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/resumen?periodo=semana")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/resumen?periodo=mes")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/empleados-ventas?periodo=semana")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/por-producto?nombre=X&periodo=semana")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/ventas/cierres?periodo=hoy")
  run_command("curl -s -H \\"x-api-token: TOKEN\\" http://tacos-api:3001/api/dashboard")

Mapeo rápido:
  "¿cuánto hoy/ayer/semana/mes?"  → /api/ventas/resumen?periodo=PERIODO
  "¿quién vendió más?"            → /api/ventas/empleados-ventas?periodo=semana
  "¿cuánto en efectivo/tarjeta?"  → /api/ventas/resumen (campo porPago)
  "¿cuánto de domicilio?"         → /api/ventas/por-producto?nombre=domicilio&periodo=semana
  "¿cuántos tacos de X?"          → /api/ventas/por-producto?nombre=X&periodo=semana
  "¿caja hoy?"                    → /api/ventas/cierres?periodo=hoy
  "resumen general"               → /api/dashboard

(En el comando curl reemplaza TOKEN por el token real de arriba)
</tools_ventas>

<tools_estado>
Para ESTADO DEL PROCESO, LOGS o ERRORES:
  view_logs(lines=100)
  run_command("tail -50 logs/error.log")
  run_command("pm2 list")
</tools_estado>

<tools_conversaciones>
Para CONVERSACIONES DE CLIENTES:
  read_file(path="datos/conversaciones/TELEFONO.txt")
  search_code(pattern="PATRON", glob="datos/**")
  list_files(path="datos/")
</tools_conversaciones>

<tools_codigo>
Para CÓDIGO O REGLAS DEL BOT:
  read_file(path="datos/instrucciones.txt")
  read_file(path="index.js")
</tools_codigo>

<proponer_mejoras>
Para proponer mejoras, incluir bloque PROPUESTA_CAMBIO...FIN_PROPUESTA en la respuesta.
</proponer_mejoras>
</sistema>`;

async function procesarConversacionLibre(convId, texto) {
    console.log(`💬 Conversación libre: "${texto.slice(0, 80)}"`);
    try {
        const resultado = await ejecutarProfundo(SYSTEM_CONV_LIBRE, texto, 300_000);
        const respuesta = (resultado.output || '(sin respuesta)').trim();
        // Procesar propuestas de código si Claude las incluyó
        parsearYEncolarPropuestas(respuesta);
        const respuestaLimpia = respuesta.replace(/PROPUESTA_CAMBIO[\s\S]*?FIN_PROPUESTA/g, '').trim();
        encolarMensaje(`conv-resp-${convId}`, `🤖 *Monitor*\n\n${respuestaLimpia || respuesta}`);
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
            // Verificar que el orquestador no tenga una recuperacion activa sobre TacosAragon
            // para evitar conflicto: orch hace stop+taskkill+start mientras monitor hace restart
            try {
                const ORCH_DB_PATH = process.env.ORCH_DB_PATH ||
                    path.join(BASE, '..', 'ecosistema-aragon', 'tacos-aragon-orchestrator', 'orchestrator', 'data', 'orchestrator.db');
                if (fs.existsSync(ORCH_DB_PATH)) {
                    const Database = require('../node_modules/better-sqlite3');
                    const orchDb = new Database(ORCH_DB_PATH, { readonly: true });
                    const falla = orchDb.prepare(
                        `SELECT en_cooldown FROM fallas WHERE servicio = 'TacosAragon' LIMIT 1`
                    ).get();
                    orchDb.close();
                    if (falla && falla.en_cooldown === 1) {
                        encolarMensaje('cmd-reiniciar-bloqueado',
                            'Monitor: El orquestador ya esta ejecutando una recuperacion sobre TacosAragon. ' +
                            'Espera a que termine (max 5 min) antes de reiniciar manualmente.'
                        );
                        break;
                    }
                }
            } catch (e) {
                // Si no se puede leer la DB del orquestador, continuar con el reinicio normal
            }

            encolarMensaje('cmd-reiniciar', 'Monitor: Reiniciando TacosAragon...');
            try {
                execSync('pm2 restart TacosAragon', { stdio: 'ignore' });
                encolarMensaje('cmd-reiniciar-ok', 'Monitor: pm2 restart TacosAragon ejecutado. Verificando conexion en 90s...');
            } catch (e) {
                encolarMensaje('cmd-reiniciar-err', `Monitor: Error al reiniciar: ${e.message}`);
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
    if (procesandoRespuestas) return;
    const rows = mensajesDb.leerResponsesPendientes();
    if (!rows.length) return;

    procesandoRespuestas = true;
    try {
        for (const resp of rows) {
            // Los mensajes pmo-* son del PMO Agent, no del monitor
            if (resp.id.startsWith('pmo')) {
                continue;
            }

            mensajesDb.marcarResponseProcesada(resp.rowid);

            if (resp.id.startsWith('cmd-')) {
                await procesarComandoAdmin(resp.texto);
                continue;
            }

            if (resp.id.startsWith('conv-')) {
                const textoNorm = (resp.texto || '').trim().toLowerCase();
                if (textoNorm === 'si' || textoNorm === 'no') {
                    const ultimo = [...pendientes].reverse().find(p => !p.datos?.aplicada);
                    if (ultimo) {
                        if (textoNorm === 'si') {
                            if (ultimo.tipo === 'propuesta') await aplicarPropuesta(ultimo);
                            else if (ultimo.tipo === 'regla_preview') await aplicarReglaAprobada(ultimo);
                            else await generarPreviewRegla(ultimo);
                        } else {
                            encolarMensaje(`resp-${ultimo.id}`, `Monitor — [${ultimo.id}] rechazado.`);
                        }
                        if (ultimo.tipo !== 'regla_preview' || textoNorm === 'no') {
                            pendientes = pendientes.filter(p => p.id !== ultimo.id);
                            guardarPendientes();
                        }
                    } else {
                        encolarMensaje(`conv-resp-${resp.id}`, `Monitor — No hay pendientes activos.`);
                    }
                    continue;
                }
                await procesarConversacionLibre(resp.id, resp.texto);
                continue;
            }

            const lookupId = resp.id.startsWith('propuesta-') ? resp.id.slice('propuesta-'.length) : resp.id;
            const pendiente = pendientes.find(p => p.id === lookupId);
            if (!pendiente) continue;

            const texto = (resp.texto || '').trim();
            console.log(`Respuesta admin [${resp.id}]: "${texto.slice(0, 60)}"`);

            if (texto.toLowerCase() === 'si') {
                if (pendiente.tipo === 'propuesta') {
                    await aplicarPropuesta(pendiente);
                } else if (pendiente.tipo === 'regla_preview') {
                    await aplicarReglaAprobada(pendiente);
                } else {
                    await generarPreviewRegla(pendiente);
                }
            } else if (texto.toLowerCase() === 'no') {
                encolarMensaje(`resp-${resp.id}`, `Monitor — [${resp.id}] rechazado.`);
            } else {
                await procesarInstruccionAdmin(texto, pendiente);
            }

            // No borrar si pasó a regla_preview (espera segundo "si")
            if (pendiente.tipo !== 'regla_preview') {
                pendientes = pendientes.filter(p => p.id !== lookupId);
                guardarPendientes();
            }
        }
    } catch (e) {
        console.error('Error procesarRespuestas:', e.message);
    } finally {
        procesandoRespuestas = false;
    }
}

// ── VERIFICACIÓN POST-REINICIO DE TACOS ARAGÓN ───────────────────────────────
let tacosRestartCount = -1; // -1 = no inicializado aún

async function verificarConexionWhatsApp(restartNum) {
    console.log(`🔍 Verificando conexión WhatsApp post-reinicio #${restartNum}...`);
    const WA_PORT = parseInt(process.env.WA_HEALTH_PORT || '3003', 10);

    try {
        const data = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${WA_PORT}/health`, { timeout: 5000 }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        });

        const json = JSON.parse(data.body);
        const exito = data.status === 200 && json.ok === true;
        const emoji = exito ? '✅' : '🔴';
        const detalle = exito
            ? `WhatsApp conectado (health :${WA_PORT} → 200)`
            : `WhatsApp NO conectado (health :${WA_PORT} → ${data.status})`;

        encolarMensaje(`verificacion-${restartNum}`,
            `${emoji} *Verificación post-reinicio #${restartNum}*\n\n${detalle}`
        );
        console.log(`  ${emoji} Resultado verificación #${restartNum}: ${detalle}`);
    } catch(e) {
        console.error('❌ verificarConexionWhatsApp:', e.message);
        encolarMensaje(`verificacion-err-${restartNum}`,
            `🔴 *Verificación post-reinicio #${restartNum}*\n\nNo se pudo contactar el health endpoint: ${e.message}`
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
            parsearYEncolarPropuestas(resumen);
            const resumenLimpio = resumen.replace(/PROPUESTA_CAMBIO[\s\S]*?FIN_PROPUESTA/g, '').trim();
            encolarMensaje('log-error-' + Date.now(),
                `🔴 *ERRORES EN LOGS DETECTADOS*\n\n` +
                `📋 ${lineasError.length} líneas de error nuevas\n\n` +
                `🤖 *Análisis:*\n${resumenLimpio || resumen}`
            );
        }
    } catch (e) {
        console.error('❌ procesarLogsError:', e.message);
    }
}

// ── INICIALIZACIÓN ────────────────────────────────────────────────────────────
// mensajes_db se inicializa al primer require (WAL mode, tablas creadas automaticamente)

// Inicializar tamaño actual de logs (no analizar todo el historial al arrancar)
try { estadoLogs.errorLogSize  = fs.statSync(ERROR_LOG).size;  } catch(e) {}
try { estadoLogs.outputLogSize = fs.statSync(OUTPUT_LOG).size; } catch(e) {}

console.log('🤖 Agente Monitor iniciado');
console.log(`   Modo: claude -p (plan Max, sin API key)`);
console.log(`   MCP: project-tacos-bot (${require('./mcp-monitor.json').mcpServers['project-tacos-bot'].args.join(' ')})`);
console.log(`   Estado previo: ${Object.keys(estadoConv).length} conversaciones analizadas`);

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
            // Si la lista está vacía, probablemente no hay acceso al Docker socket — no alertar
            if (procs.length === 0) {
                console.log('⏱️ Revisión 30min: pm2 jlist vacío (sin acceso Docker socket) — omitiendo');
                return;
            }
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

// La limpieza de cola la maneja el telegram-dispatcher (SQLite mensajes_queue).

process.on('SIGINT',  () => { guardarEstado(); process.exit(0); });
process.on('SIGTERM', () => { guardarEstado(); process.exit(0); });
process.on('uncaughtException',  (err) => console.error('💀 Monitor error:', err.message));
process.on('unhandledRejection', (r)   => console.error('💀 Monitor rejection:', r));
