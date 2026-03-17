# Tacos Aragón — Quality Monitor Agent

Independent process that watches the Tacos Aragón WhatsApp bot conversations in real time. Uses **Claude Sonnet** (`claude-sonnet-4-6`) via the Anthropic API to analyze exchanges, detect quality errors, and propose automatic corrections to the admin.

---

## What it does

### Real-time monitoring
- Reads the main bot's SQLite database (`conversaciones.db`) every time a change is detected.
- For each new or updated conversation, extracts the lines it hasn't analyzed yet.
- Sends that fragment to Claude to detect whether a service error occurred.

### Problem detection
Detects errors such as:
- Unavailable items included in a confirmed order
- Wrong price on the ticket
- Customer name mentioned in the bot's response (prohibited behavior)
- Repeated unnecessary questions about info the customer already provided
- Payment method asked for pickup orders

When a problem is detected, the monitor sends a WhatsApp alert to the admin with:
- Severity level (High / Medium / Low)
- Affected customer's phone number
- Problem description
- Literal conversation excerpt
- Correction suggestion
- Commands to approve or reject (`!m si` / `!m no`)

### Code proposals
When the same error repeats structurally, the monitor can propose direct changes to:
- `datos/instrucciones.txt` — bot behavior rules
- `index.js` — message pipeline logic
- `loyverse_integration.js` — POS integration

Proposals are sent to the admin for approval. Upon approval, the monitor applies the change and automatically backs up the original file.

### Log monitoring
- Detects error lines in `logs/error.log` (crashes, timeouts, Chrome errors, API errors).
- Filters relevant lines and analyzes them with Claude to provide a diagnosis with suggested steps.

### Post-restart verification
Every time the main bot (TacosAragon) restarts, the monitor waits 90 seconds and then checks whether WhatsApp connected correctly. Reports the result to the admin.

### Periodic health check
Every 30 minutes it checks the status of the TacosAragon process (via PM2). If it detects it is down or has recent errors, it alerts the admin.

### On-demand deep analysis
With the command `!m reporte`, the monitor runs a full agentic loop with access to all tools:
1. Reviews the last 200 lines of `logs/error.log`
2. Reviews the last 150 lines of `logs/output.log`
3. Reads recent human interventions
4. Lists all active conversations
5. Reads the longest or most suspicious ones
6. Looks for error patterns across conversations
7. Reads relevant source code
8. Proposes changes if it finds a root cause

---

## Architecture

```
Main bot (TacosAragon)               Monitor (MonitorBot)
─────────────────────────────        ─────────────────────────────────
index.js                             agente_monitor.js
  └─ datos/conversaciones.db  ←───  reads conversations (WAL mode)
  └─ logs/error.log           ←───  detects new errors
  └─ datos/agente_queue.json  ←───  receives messages to forward to admin
  └─ datos/agente_responses.json ──→ receives admin replies
  └─ datos/instrucciones.txt  ←───  (proponer_cambio can modify it)
  └─ index.js / loyverse.js   ←───  (proponer_cambio can modify it)
```

**IPC via JSON:** The bot and the monitor communicate by writing JSON files in `datos/`. No sockets or HTTP between them.

---

## Available tools (tool use)

| Tool | Description |
|------|-------------|
| `leer_archivo` | Reads any file from the bot's system |
| `leer_conversacion` | Reads a customer's full chat history by phone number |
| `leer_perfil_cliente` | Reads a customer's saved profile |
| `leer_intervenciones` | Reads the history of human interventions (`!humano`) |
| `listar_conversaciones` | Lists all customers in the DB with their last activity |
| `buscar_en_conversaciones` | Searches a text pattern across all conversations |
| `ejecutar_shell` | Runs read-only commands (tail, cat, grep, pm2 status/logs) |
| `consultar_api` | Calls the central bot API for sales/order data |
| `proponer_cambio` | Proposes a code change for admin approval |
| `enviar_media` | Sends an image, audio, or file to the admin via WhatsApp |
| `cargar_skill` | Loads specialized instructions (alerts, proposals, logs, etc.) |

---

## Admin commands (via WhatsApp)

| Command | Action |
|---------|--------|
| `!m si` | Apply last pending alert/proposal |
| `!m no` | Reject last pending alert/proposal |
| `!m reporte` | Deep analysis with tool use |
| `!m estado` | Monitor status (no API call) |
| `!m propuestas` | List pending code proposals |
| `!m reiniciar` | Restart the TacosAragon process |
| `!m [free text]` | Talk to the monitor / give instructions |

---

## Installation

### Requirements
- Node.js 18+
- PM2 (`npm install -g pm2`)
- The main Tacos Aragón bot running (they share the SQLite database)
- Anthropic API Key (account with credits at [console.anthropic.com](https://console.anthropic.com))

### Steps

```bash
# 1. Clone this repo
git clone https://github.com/Gumagonza1/tacos-aragon-monitor.git
cd tacos-aragon-monitor

# 2. Install dependencies
npm install

# 3. Configure
# Edit ecosystem.config.js and set:
#   BOT_BASE  → absolute path to the main bot directory
#   ANTHROPIC_KEY → your Anthropic API key
#   TACOS_API_URL / TACOS_API_TOKEN → if using the central API

# 4. Start with PM2
pm2 start ecosystem.config.js

# 5. View logs
pm2 logs MonitorBot
```

### BOT_BASE configuration

The monitor needs to point to the main bot's root directory to read its files:

```javascript
// ecosystem.config.js
env: {
    BOT_BASE: 'C:/Users/your_user/Desktop/bot-tacos',  // Windows
    // BOT_BASE: '/home/user/bot-tacos',                 // Linux/Mac
    ANTHROPIC_KEY: 'sk-ant-...',
}
```

If `BOT_BASE` is not set, the monitor assumes the bot is at `../bot-tacos` relative to this repo.

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_KEY` | Yes | Anthropic API Key. Alternative: `datos/anthropic_key.txt` file in the main bot |
| `BOT_BASE` | No | Path to the main bot's root directory. Default: `../bot-tacos` |
| `TACOS_API_URL` | No | Central bot API URL. Default: `http://localhost:3001` |
| `TACOS_API_TOKEN` | No | Central API auth token |

---

## Model and cost

- Model: `claude-sonnet-4-6` (Anthropic)
- Billed per tokens consumed — the Anthropic API is pay-per-use
- A claude.ai subscription **does not** work here — they are separate products
- Quick per-conversation analysis is inexpensive (few lines of text)
- Deep analysis (`!m reporte`) consumes more tokens due to the agentic loop

To control spending, adjust the periodic review frequency in `agente_monitor.js` (default: every 30 minutes).

---

## File structure

```
tacos-aragon-monitor/
├── agente_monitor.js      # Main monitor process
├── skills/                # Specialized instructions for the agent
│   ├── alertas.md         # When and how to generate alerts
│   ├── propuestas.md      # When and how to propose code changes
│   ├── logs.md            # How to analyze error logs
│   ├── conversacion.md    # How to analyze conversations
│   └── menu.md            # Menu context for the agent
├── ecosystem.config.js    # PM2 configuration
├── package.json
└── .gitignore
```

---

## Integration with the main bot

This monitor is part of the **Tacos Aragón** ecosystem:

- **Main bot:** [whatsapp-tacos-bot](https://github.com/Gumagonza1/whatsapp-tacos-bot)
- **Monitor:** this repository
- **Central API:** [tacos-aragon-api](https://github.com/Gumagonza1/tacos-aragon-api)

All three processes run independently on the same machine and communicate through shared JSON files and the main bot's SQLite database.

---
---

# Tacos Aragón — Agente Monitor de Calidad

Proceso independiente que vigila en tiempo real las conversaciones del bot de WhatsApp de Tacos Aragón. Usa **Claude Sonnet** (`claude-sonnet-4-6`) vía Anthropic API para analizar intercambios, detectar errores de calidad y proponer correcciones automáticas al admin.

---

## Qué hace

### Vigilancia en tiempo real
- Lee la base de datos SQLite del bot principal (`conversaciones.db`) cada vez que hay un cambio.
- Para cada conversación nueva o actualizada, extrae las últimas líneas que no ha analizado todavía.
- Envía ese fragmento a Claude para que detecte si hubo algún error de atención.

### Detección de problemas
Detecta errores como:
- Artículos no disponibles incluidos en una orden confirmada
- Precio incorrecto en el ticket
- Nombre del cliente mencionado en la respuesta del bot (comportamiento prohibido)
- Preguntas repetidas innecesarias sobre info ya proporcionada por el cliente
- Método de pago preguntado en órdenes de recoger

Cuando detecta un problema, el monitor envía una alerta por WhatsApp al administrador con:
- Nivel de severidad (Alta / Media / Baja)
- Teléfono del cliente afectado
- Descripción del problema
- Fragmento literal de la conversación
- Sugerencia de corrección
- Comandos para aprobar o rechazar (`!m si` / `!m no`)

### Propuestas de código
Cuando el mismo error se repite de forma estructural, el monitor puede proponer cambios directos a:
- `datos/instrucciones.txt` — reglas de comportamiento del bot
- `index.js` — lógica del pipeline de mensajes
- `loyverse_integration.js` — integración con el POS

Las propuestas se envían al admin para aprobación. Al aprobar, el monitor aplica el cambio y hace un backup automático del archivo original.

### Vigilancia de logs
- Detecta líneas de error en `logs/error.log` (crashes, timeouts, errores de Chrome, errores de API).
- Filtra las líneas relevantes y las analiza con Claude para proporcionar un diagnóstico con pasos sugeridos.

### Verificación post-reinicio
Cada vez que el bot principal (TacosAragon) se reinicia, el monitor espera 90 segundos y luego verifica si WhatsApp se conectó correctamente. Informa al admin con el resultado.

### Revisión periódica
Cada 30 minutos revisa el estado del proceso TacosAragon (via PM2). Si detecta que está caído o con errores recientes, alerta al admin.

### Análisis profundo bajo demanda
Con el comando `!m reporte`, el monitor ejecuta un bucle agéntico completo con acceso a todas las herramientas:
1. Revisa los últimos 200 líneas de `logs/error.log`
2. Revisa los últimos 150 líneas de `logs/output.log`
3. Lee las intervenciones humanas recientes
4. Lista todas las conversaciones activas
5. Lee las más largas o sospechosas
6. Busca patrones de error entre conversaciones
7. Lee el código fuente relevante
8. Propone cambios si detecta causa raíz

---

## Arquitectura

```
Bot principal (TacosAragon)          Monitor (MonitorBot)
─────────────────────────────        ─────────────────────────────────
index.js                             agente_monitor.js
  └─ datos/conversaciones.db  ←───  lee conversaciones (WAL mode)
  └─ logs/error.log           ←───  detecta errores nuevos
  └─ datos/agente_queue.json  ←───  recibe mensajes para enviar al admin
  └─ datos/agente_responses.json ──→ recibe respuestas del admin
  └─ datos/instrucciones.txt  ←───  (proponer_cambio puede modificarlo)
  └─ index.js / loyverse.js   ←───  (proponer_cambio puede modificarlo)
```

**IPC vía JSON:** El bot y el monitor se comunican escribiendo archivos JSON en `datos/`. No hay sockets ni HTTP entre ellos.

---

## Herramientas disponibles (tool use)

| Herramienta | Descripción |
|-------------|-------------|
| `leer_archivo` | Lee cualquier archivo del sistema del bot |
| `leer_conversacion` | Lee el historial completo de un cliente por teléfono |
| `leer_perfil_cliente` | Lee el perfil guardado de un cliente |
| `leer_intervenciones` | Lee el historial de intervenciones humanas (`!humano`) |
| `listar_conversaciones` | Lista todos los clientes en la DB con su última actividad |
| `buscar_en_conversaciones` | Busca un patrón de texto en todas las conversaciones |
| `ejecutar_shell` | Ejecuta comandos de lectura (tail, cat, grep, pm2 status/logs) |
| `consultar_api` | Llama a la API central del bot para datos de ventas/órdenes |
| `proponer_cambio` | Propone un cambio de código para aprobación del admin |
| `enviar_media` | Envía imagen, audio o archivo al admin por WhatsApp |
| `cargar_skill` | Carga instrucciones especializadas (alertas, propuestas, logs, etc.) |

---

## Comandos del admin (vía WhatsApp)

| Comando | Acción |
|---------|--------|
| `!m si` | Aplicar última alerta/propuesta pendiente |
| `!m no` | Rechazar última alerta/propuesta pendiente |
| `!m reporte` | Análisis profundo con tool use |
| `!m estado` | Estado del monitor (sin consumir API) |
| `!m propuestas` | Listar propuestas de código pendientes |
| `!m reiniciar` | Reinicia el proceso TacosAragon |
| `!m [texto libre]` | Conversar con el monitor / dar instrucciones |

---

## Instalación

### Requisitos
- Node.js 18+
- PM2 (`npm install -g pm2`)
- El bot principal de Tacos Aragón corriendo (comparten la base de datos SQLite)
- API Key de Anthropic (cuenta con créditos en [console.anthropic.com](https://console.anthropic.com))

### Pasos

```bash
# 1. Clonar este repo
git clone https://github.com/Gumagonza1/tacos-aragon-monitor.git
cd tacos-aragon-monitor

# 2. Instalar dependencias
npm install

# 3. Configurar
# Editar ecosystem.config.js y ajustar:
#   BOT_BASE  → ruta absoluta al directorio del bot principal
#   ANTHROPIC_KEY → tu API key de Anthropic
#   TACOS_API_URL / TACOS_API_TOKEN → si usas la API central

# 4. Iniciar con PM2
pm2 start ecosystem.config.js

# 5. Ver logs
pm2 logs MonitorBot
```

### Configuración de BOT_BASE

El monitor necesita apuntar al directorio raíz del bot principal para leer sus archivos:

```javascript
// ecosystem.config.js
env: {
    BOT_BASE: 'C:/Users/tu_usuario/Desktop/bot-tacos',  // Windows
    // BOT_BASE: '/home/usuario/bot-tacos',              // Linux/Mac
    ANTHROPIC_KEY: 'sk-ant-...',
}
```

Si no configuras `BOT_BASE`, el monitor asume que el bot está en `../bot-tacos` relativo a este repo.

---

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `ANTHROPIC_KEY` | Sí | API Key de Anthropic. Alternativa: archivo `datos/anthropic_key.txt` en el bot principal |
| `BOT_BASE` | No | Ruta al directorio raíz del bot principal. Default: `../bot-tacos` |
| `TACOS_API_URL` | No | URL de la API central del bot. Default: `http://localhost:3001` |
| `TACOS_API_TOKEN` | No | Token de autenticación de la API central |

---

## Modelo y costo

- Modelo: `claude-sonnet-4-6` (Anthropic)
- Se cobra por tokens consumidos — la API de Anthropic es de pago por uso
- La suscripción a claude.ai **no** sirve para esto — son productos separados
- El análisis rápido por conversación es económico (pocas líneas de texto)
- El análisis profundo (`!m reporte`) consume más tokens por el bucle agéntico

Para controlar el gasto, ajusta la frecuencia de revisión periódica en `agente_monitor.js` (por defecto cada 30 minutos).

---

## Estructura de archivos

```
tacos-aragon-monitor/
├── agente_monitor.js      # Proceso principal del monitor
├── skills/                # Instrucciones especializadas para el agente
│   ├── alertas.md         # Cuándo y cómo generar alertas
│   ├── propuestas.md      # Cuándo y cómo proponer cambios de código
│   ├── logs.md            # Cómo analizar logs de error
│   ├── conversacion.md    # Cómo analizar conversaciones
│   └── menu.md            # Contexto del menú para el agente
├── ecosystem.config.js    # Configuración PM2
├── package.json
└── .gitignore
```

---

## Integración con el bot principal

Este monitor es parte del ecosistema **Tacos Aragón Bot**:

- **Bot principal:** [whatsapp-tacos-bot](https://github.com/Gumagonza1/whatsapp-tacos-bot)
- **Monitor:** este repositorio
- **API central:** [tacos-aragon-api](https://github.com/Gumagonza1/tacos-aragon-api)

Los tres procesos corren de forma independiente en la misma máquina y se comunican a través de archivos JSON compartidos y la base de datos SQLite del bot principal.
