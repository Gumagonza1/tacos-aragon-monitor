# Skill: Leer e interpretar logs de PM2

## Rutas de logs
- Output: `logs/output.log`
- Errores: `logs/error.log`

## Patrones importantes a buscar

### Errores críticos
- `TargetCloseError` / `Session closed` → Chrome se cayó, bot necesita reinicio
- `Error: Protocol error` → problema de conexión con Chrome/WhatsApp Web
- `ECONNREFUSED` → API externa no disponible (Loyverse, Gemini, etc.)
- `429` / `rate limit` → límite de API alcanzado
- `gemini` + `404` / `no longer available` → modelo de Gemini deprecado

### Errores de órdenes
- `❌ Loyverse` → falló registro de orden en POS → verificar receipt
- `Error al crear orden` → orden confirmada pero no registrada
- `timeout` en llamada a Gemini → respuesta tardó más de 60s

### Señales de salud
- `✅ SISTEMA ACTIVO` → bot inició correctamente
- `🗣️ IA:` → bot respondió a cliente
- `⏳ [nombre]` → mensaje en buffer (normal)
- `💰 Precios sincronizados` → sync Loyverse OK

### Patrones de negocio
- `💰` seguido de receipt number → venta registrada
- `!humano` → cliente pidió intervención humana (bot pausado para ese número)
- `[Autónomo]` → proceso autónomo ejecutó acción programada

## Comandos útiles
```
pm2 logs TacosAragon --nostream --lines 100
pm2 logs MonitorBot --nostream --lines 50
```

## Herramientas para este skill
- `ejecutar_shell("pm2 logs TacosAragon --nostream --lines 100")`
- `ejecutar_shell("grep -n 'Error\\|❌\\|crash' logs/error.log | tail -20")`
