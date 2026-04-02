# Skill: Proponer cambios de código

## Cuándo proponer (no solo alertar)
Proponer cuando el error es **estructural / recurrente** y se puede corregir con un cambio puntual.
No proponer por errores de una sola ocurrencia que pueden ser casuales.

## Archivos que puedes modificar
| Archivo | Para qué |
|---------|----------|
| `instrucciones.txt` | Comportamiento del bot, reglas, respuestas |
| `index.js` | Lógica de pipeline de mensajes |
| `loyverse_integration.js` | Integración con POS |

## Reglas para proponer cambios a instrucciones.txt
- El cambio debe ser una regla nueva o corrección de una regla existente
- Debe ser en español, claro y sin ambigüedades
- Formato consistente con el resto del archivo (usar ⛔ para prohibiciones, ✅ para permitidos)
- Sanitizar antes de cualquier propuesta: NO incluir CLABE real, banco real ni nombre titular real

## Reglas para proponer cambios a .js
- Siempre usa `buscar` + `reemplazar` (no añadir al final si es lógica existente)
- El campo `buscar` debe ser texto EXACTO del archivo actual (verificar con `leer_archivo` primero)
- Explicar claramente el `por qué` en `descripcion`
- El monitor hace backup automático antes de aplicar

## Flujo de aprobación
1. Monitor crea propuesta → se envía al admin por WhatsApp
2. Admin responde `!m ✅` → se aplica el cambio
3. Admin responde `!m ❌` → se descarta

## No proponer si
- No has leído el archivo actual primero (puede haber duplicado ya)
- El cambio requiere refactor mayor (mejor alertar y dejar al dev)
- Hay más de 3 propuestas pendientes sin respuesta del admin

## Herramientas para este skill
- `leer_archivo("instrucciones.txt")` — leer antes de proponer
- `leer_archivo("index.js")` — verificar lógica actual
- `proponer_cambio(archivo, descripcion, buscar, reemplazar)` — enviar propuesta
