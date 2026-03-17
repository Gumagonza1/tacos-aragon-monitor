# Skill: Analizar conversación de cliente

## Qué buscar (en orden de severidad)

### 🔴 Alta severidad
- Bot confirma ítem que está en `datos/no_disponible.txt` (actualmente: **ubre, tonicol, adobada**)
- Bot menciona el nombre del cliente en cualquier respuesta
- Precio en ORDEN CONFIRMADA distinto al menú vigente
- Orden confirmada con ítems que el cliente NO pidió / faltan ítems que sí pidió
- Bot preguntó proactivamente si va a facturar (solo debe responder si el cliente lo pide)
- Bot dio datos bancarios / link de pago sin ORDEN CONFIRMADA en ese mismo mensaje

### 🟡 Media severidad
- Bot preguntó por verduras ("¿con todo?") cuando el cliente ya lo dijo en ese mismo mensaje
  - Palabras que ya responden la pregunta: **natural, naturales, con todo, sin cebolla, sin frijol, puro jugo, sin chile, sin nada**
- Bot preguntó por método de pago en orden de **RECOGER** (solo preguntar en domicilio)
- Bot ofreció adobada como opción en sus preguntas (aunque el cliente no la pidiera)
- Bot aplicó "con todo" / "natural" solo a uno de varios ítems cuando el cliente no diferenció
- Bot preguntó por carne cuando el cliente ya especificó en el mismo mensaje

### 🟠 Baja severidad
- Tono incorrecto (grosero, condescendiente, muy largo)
- Información incorrecta sobre horarios o políticas
- Bot dijo que no tiene info de métodos de pago (siempre debe decir: efectivo, transferencia, tarjeta, link de pago)

## Regla de oro de verduras
Si el cliente usó **"natural/naturales", "con todo", "sin X"** en su mensaje → NO preguntar de nuevo.
Si el cliente dijo la instrucción para múltiples ítems con una frase general → aplicar a todos.

## Regla de carne
Si el bot preguntó "¿de qué carne?" para N ítems y el cliente respondió UNA sola carne sin diferenciar → aplicar esa carne a TODOS.

## Cómo leer la conversación
- `Cliente:` = mensaje del usuario
- `Bot:` = respuesta del sistema
- `[GPS]` = ubicación compartida (bot debe calcular distancia y zona de envío)
- `[IMAGEN ADJUNTA]` = imagen enviada (bot debe analizarla)

## Herramientas útiles para este skill
- `leer_conversacion(telefono)` — últimos N chars del historial
- `leer_archivo("no_disponible.txt")` — ítems actualmente no disponibles
- `leer_archivo("instrucciones.txt")` — reglas completas del bot
