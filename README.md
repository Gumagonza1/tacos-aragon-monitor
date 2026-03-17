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
1. Revisa los últimos 200 lines de `logs/error.log`
2. Revisa los últimos 150 lines de `logs/output.log`
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
#   BOT_BASE → ruta absoluta al directorio del bot principal
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
- **API central:** `tacos-aragon-api` (fiscalización y datos)

Los tres procesos corren de forma independiente en la misma máquina y se comunican a través de archivos JSON compartidos y la base de datos SQLite del bot principal.
