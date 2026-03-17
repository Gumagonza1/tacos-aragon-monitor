# Skill: Generar y enviar alertas

## Cuándo generar alerta (no falsos positivos)

Solo alertar si el error es **concreto y verificable** en el texto de la conversación.
No alertar por suposiciones o interpretaciones ambiguas.

### Condiciones para alerta ALTA
- Ítem no disponible confirmado en orden
- Precio incorrecto en ticket
- Nombre del cliente mencionado
- Orden confirmada con errores de ítems (faltantes o extras no pedidos)

### Condiciones para alerta MEDIA
- Pregunta repetida sobre ingredientes ya especificados
- Método de pago preguntado en orden de recoger
- Bot dijo no tener info de métodos de pago

### No alertar por
- Preguntar carne si el cliente genuinamente no la especificó
- Preguntar dirección si el cliente no la dio
- Confirmar pedido en dos mensajes separados (===SEPARAR===)
- El cliente cambió de opinión mid-conversation

## Formato de alerta a admin
El monitor envía por WhatsApp al admin principal.
Mantener conciso: problema + cliente + cita literal.

## Escalar si
- 3+ errores del mismo tipo en 10 minutos → alerta de patrón
- Error de precio que ya fue cobrado en Loyverse → urgente, indicar receipt number si está visible

## Herramientas útiles
- `leer_conversacion(telefono)` — verificar contexto antes de alertar
- `leer_archivo("no_disponible.txt")` — confirmar si el ítem está prohibido
- `ejecutar_shell("pm2 logs TacosAragon --nostream --lines 50")` — ver receipt number reciente
