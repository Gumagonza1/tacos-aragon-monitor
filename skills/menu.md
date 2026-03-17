# Skill: Menú y disponibilidad

## Artículos actualmente NO DISPONIBLES
Leer siempre desde `datos/no_disponible.txt` (cambia con frecuencia).
Comando: `leer_archivo("no_disponible.txt")`

**Regla absoluta:** El bot NUNCA debe sugerir, ofrecer, confirmar ni aceptar un pedido de ítem no disponible,
aunque el cliente lo pida explícitamente. Debe redirigir a opciones disponibles.

## Estructura del menú (menu.csv)
- Columnas: NOMBRE, PRECIO, ITEM_ID, VARIANT_ID
- Los IDs son UUIDs de Loyverse — no se muestran al cliente
- El precio en CSV puede estar desactualizado (sincronizar con Loyverse si hay duda)

## Carnes disponibles normalmente
- **Asada** (siempre disponible)
- **Revuelta** (asada + adobada, verificar si adobada está en no_disponible antes de ofrecerla)
- **Adobada** — actualmente en no_disponible.txt → ⛔ NO OFRECER

## Modificadores de verdura
- **Con todo** = con todos los ingredientes
- **Natural / Naturales** = sin verduras (solo carne)
- **Sin X** = sin ese ingrediente específico
- **Puro jugo** = solo jugo de la carne

## Horario del negocio
Martes a domingo, 18:00–23:30 (GMT-7). Lunes cerrado.

## Combos
- Verificar que el nombre del combo corresponda al día actual
- Combo Miércoles solo válido miércoles, Combo Jueves solo jueves, etc.
- **Combo del Mes** = disponible todos los días del mes

## Herramientas para este skill
- `leer_archivo("menu.csv")` — menú completo con precios
- `leer_archivo("no_disponible.txt")` — artículos prohibidos hoy
