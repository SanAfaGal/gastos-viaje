# Espacios por código: grupos separados en la misma app

Nota: el apartado del administrador de este diseño fue reemplazado por `2026-11-19-administrador-separado-design.md` (el administrador ya no es el espacio Principal).

Fecha: 2026-11-19. Estado: pendiente de aprobación.

## Intención

Hoy la app tiene un único código global (`APP_PASSCODE`, enviado en el header `x-passcode`). Quien lo conoce ve y modifica todo: `/api/state` devuelve todas las filas de `people`, `trips`, `payment_methods`, `expenses` y `payments`. Ninguna tabla tiene dueño.

Se quiere que otras personas usen la misma app (la misma URL y la misma base) sin acceder a los viajes del dueño actual, y sin que el dueño acceda a los de ellos. Los otros usuarios son **grupos totalmente separados**: no comparten viajes ni personas con nadie. El código deja de ser solo una contraseña y pasa a ser la llave de un **espacio** aparte.

## Objetivos

- Cada grupo entra con su propio código y ve únicamente su espacio: sus viajes, personas, medios de pago, gastos y abonos.
- El administrador (el dueño actual) crea, regenera y desactiva espacios desde la propia app, sin necesitar acceso a una terminal.
- El administrador no puede ver datos de otros espacios. Solo ve nombre, fecha de creación y si está activo.
- Los datos y el código actuales del dueño siguen funcionando sin cambios en los celulares.
- Un espacio nunca puede leer, escribir ni referenciar filas de otro, ni siquiera conociendo sus ids.

## No objetivos

- Compartir un viaje entre espacios, o que una persona pertenezca a dos espacios.
- Registro abierto: nadie crea un espacio sin pasar por el administrador.
- Cuentas con correo, contraseñas o recuperación de clave.
- Una base de datos por grupo.
- Ver cuánto usa cada espacio (conteos de gastos, etc.) en la pantalla de administrador.

## Anti-objetivos (fracaso aunque funcione)

- Que un grupo vea datos de otro por un filtro olvidado en una consulta.
- Que el administrador pueda mirar datos de otros grupos, aunque sea "solo para ayudar".
- Que cambiar de código en un mismo celular mezcle datos o envíe gastos pendientes a otro espacio.
- Que los celulares de hoy pidan código de nuevo o pierdan datos al migrar.

## Restricciones del proyecto actual

- Una base (SQLite local o Turso en línea) con migraciones idempotentes que corren en cada arranque (`src/db.mjs`). La migración debe seguir ese estilo.
- `src/handlers.mjs` es el único lugar con las reglas; lo usan `server.mjs` (local) y `netlify/functions/api.mjs` (en línea).
- Los ids los genera el cliente (`crypto.randomUUID`) y los guardados con `PUT /api/<recurso>/:id` hacen upsert (`ON CONFLICT(id) DO UPDATE`). Por eso, hoy cualquiera que conozca un id puede sobrescribir esa fila. Con varios espacios esto es una fuga: ver "Aislamiento".
- Sin `APP_PASSCODE` (desarrollo local y pruebas) la app no pide código. Eso debe seguir igual.
- El cliente guarda en `localStorage` una copia del estado (`bg_state2`), la cola de gastos pendientes (`bg_queue`), tasas, historial, viaje activo y el código (`bg_pass`). Ver "Cambio de código en un celular".
- El límite de intentos fallidos (10 por red, 300 globales cada 15 min, tabla `auth_failures`) se mantiene.
- Pruebas con `node --test` (carpeta `test/`), 163 hoy.

## Enfoques considerados

1. **Un espacio por código en la misma base (elegido).** Tabla `spaces`; columna `space_id` en las tablas raíz; el servidor filtra todo por el espacio resuelto desde el código. Una base y un despliegue; un grupo nuevo es una fila. Riesgo: un filtro olvidado filtra datos, que se cubre con pruebas de aislamiento sobre cada ruta.
2. **Una base Turso por grupo.** Aislamiento físico, casi sin tocar consultas. Cada grupo nuevo exige crear la base, guardar URL y token en Netlify y migrarla, a mano y con redespliegue. Desproporcionado para grupos pequeños.
3. **Cuentas reales (correo y contraseña).** Estándar, pero exige correo, recuperación de clave y sesiones, y no encaja con grupos que entran con un código.

Se eligió el 1. Para crear los códigos se descartó un script de línea de comandos porque el dueño no siempre tiene acceso a una terminal: se hace una pantalla de administrador en la app.

## Diseño

### Datos

Tabla nueva:

```
spaces(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_hash TEXT,            -- hash del código; NULL en el espacio administrador (su código es APP_PASSCODE)
  is_admin INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
)
```

Columna `space_id TEXT REFERENCES spaces(id)` en `people`, `trips` y `payment_methods`. Gastos, abonos, beneficiarios y `trip_people` heredan el espacio por su viaje o su gasto; no llevan columna propia. `rates` y `settings` siguen globales: las tasas son datos públicos de caché y no hay nada privado.

### Resolución del código

- Si el código recibido coincide (comparación en tiempo constante, como hoy) con `APP_PASSCODE`, el espacio es el administrador. `APP_PASSCODE` es la única forma de entrar como administrador, y también el respaldo si se pierde: cambiar la variable en Netlify restablece el acceso.
- Si no, se busca un espacio activo cuyo `code_hash` sea el hash del código. Un código inexistente da 401 "Código incorrecto". El código exacto de un espacio desactivado da 403 "Este espacio está desactivado. Habla con quien te dio el código." y ese intento no cuenta para el límite (decisión posterior al diseño inicial, que daba el mismo error a los dos: solo lo ve quien ya tiene el código completo de 12 caracteres al azar, así que no revela qué espacios existen).
- El conteo de intentos y el bloqueo de `checkAuth` no cambian: cada intento con código se cuenta antes de resolverlo.
- Sin `APP_PASSCODE` configurado y sin código: se usa el espacio administrador, como hoy.
- `handle()` resuelve el espacio una vez y se lo pasa a cada función. Ninguna función acepta consultas sin espacio.

### Aislamiento (lo más delicado)

Reglas que aplican a toda ruta:

- Toda lectura filtra por el espacio, directo (`space_id`) o por su viaje.
- Todo acceso por id verifica que la fila pertenezca al espacio. Un id de otro espacio da 404 / "no existe", igual que un id inexistente.
- Los upserts (`PUT`) no pueden pisar filas ajenas: si el id existe en otro espacio, se rechaza; el `ON CONFLICT ... DO UPDATE` solo actúa si la fila es del espacio.
- Toda referencia cruzada se valida en el mismo espacio: medio de pago y beneficiarios de un gasto, personas de un abono, dueño de un medio de pago, personas de un viaje. Una referencia a otro espacio se trata como inexistente.
- `getTrip` sin id devuelve el primer viaje **del espacio**, no el primero de la base. Cada espacio siempre tiene al menos un viaje: al crear un espacio se crea "Viaje 1" con las monedas por defecto, y `deleteTrip` ya impide borrar el único.
- `fillPendingRates`, `refreshTripRates` y `getState` se limitan al espacio.
- Respaldo y restauración (`src/backup.mjs`) operan solo sobre el espacio: el respaldo exporta únicamente sus filas y restaurar inserta en su espacio. Un `INSERT OR IGNORE` por id que choque con otro espacio no debe ignorarse en silencio ni tocar la fila ajena.

### Administración de espacios

Rutas nuevas, solo para el espacio con `is_admin`; cualquier otro recibe 404:

- `GET /api/spaces`: lista de `{ id, name, created_at, active }`. Nunca devuelve datos del espacio ni hashes.
- `POST /api/spaces` con `{ name }`: crea el espacio, genera el código y lo devuelve **una sola vez** en la respuesta.
- `POST /api/spaces/:id/regenerate`: genera un código nuevo; el anterior deja de servir. Devuelve el nuevo una sola vez.
- `PUT /api/spaces/:id` con `{ active }`: desactiva o reactiva sin borrar datos.

El espacio administrador no se puede desactivar ni regenerar desde la app (su código es `APP_PASSCODE`).

Código generado: 12 caracteres de un alfabeto sin ambiguos (sin `0/O`, `1/I/L`), con `crypto.randomInt`, escrito en grupos de 4 (`K7M4-X9QD-H2RT`). Se guarda solo su hash (SHA-256 con sal fija de la app o HMAC con un secreto; ver "Queda para quien construya"). Al compararlo se ignoran los guiones y las mayúsculas/minúsculas.

Pantalla: sección **Espacios** en Ajustes, visible solo si el espacio actual es administrador. Lista con nombre, fecha y estado; botón para crear (pide el nombre, muestra el código una vez con botón de copiar y compartir); acciones por fila para regenerar y desactivar/reactivar, con confirmación en las dos. El cliente sabe si es administrador porque `/api/state` incluye `space: { name, is_admin }` del espacio actual.

### Cambio de código en un celular

El cliente guarda en `localStorage` datos de un espacio. Si alguien entra con otro código en el mismo celular, esos datos (estado, cola de pendientes, tasas, viaje activo) pertenecían a otro espacio y no deben mezclarse ni enviarse al nuevo. `/api/state` devuelve el id del espacio y el cliente lo guarda junto con la copia local; al detectar que el id cambió (o al guardar un código distinto en la pantalla de acceso), descarta estado, cola, historial y viaje activo antes de cargar el nuevo. Antes de borrar una cola con gastos sin enviar se avisa al usuario, porque son datos que no llegaron al servidor.

### Migración

En el arranque, idempotente, en el estilo de `upgradeTrips`:

1. Crea la tabla `spaces` si no existe.
2. Crea el espacio administrador (`id` fijo, `is_admin = 1`, `code_hash` NULL) si no existe.
3. Agrega `space_id` a `people`, `trips` y `payment_methods` si falta, y asigna el espacio administrador a todas las filas existentes que no lo tengan.

Los celulares de hoy siguen usando `APP_PASSCODE` y ven lo mismo que antes.

## Pruebas

- Aislamiento: con dos espacios, probar cada ruta (estado, viajes, personas, medios, gastos, abonos, tasas, respaldo, restauración, orden) leyendo y escribiendo con ids del otro espacio; nunca debe filtrar datos ni modificar filas ajenas.
- Referencias cruzadas rechazadas (gasto con medio de pago o persona de otro espacio, abono entre personas de otro espacio).
- `PUT` con un id que ya existe en otro espacio no lo pisa.
- Resolución del código: administrador, espacio activo, espacio desactivado, código inexistente (401) y de un espacio desactivado (403, sin gastar intentos), código regenerado (el viejo falla), código sin guiones o en minúsculas.
- Límite de intentos con varios espacios sigue funcionando.
- Rutas de administración: un espacio normal recibe 404; el administrador crea, lista, regenera y desactiva; las respuestas nunca incluyen datos de otros espacios ni hashes; el código solo aparece en la respuesta de crear y regenerar.
- Migración: una base con datos actuales pasa a tener espacio administrador con todas las filas, sin pérdidas, y es idempotente.
- Cliente: cambiar de código descarta la copia local y la cola.

## Queda para quien construya

- Hash del código: SHA-256 simple es suficiente porque el código es aleatorio de alta entropía, no una clave elegida por una persona. Decidir si se usa una sal o un HMAC con un secreto de entorno.
- Verificar que las respuestas de `/api/*` no sean cacheables de forma compartida (el ETag de `/api/state` sale del cuerpo, que ya sería distinto por espacio).
- Forma exacta de aplicar el filtro de espacio en cada consulta de `handlers.mjs` y de reordenar sus funciones; el límite de 700 líneas por archivo del proyecto puede pedir partir `handlers.mjs`.
- Textos y diseño de la sección **Espacios** y del aviso al cambiar de código con una cola sin enviar.
- Actualizar el README (variables, administración de espacios) y subir la versión del service worker.

## Decisiones tomadas por mí (para que las revises)

- El espacio administrador usa `APP_PASSCODE` como único código; no se regenera desde la app y la variable sirve de respaldo.
- Cada espacio nuevo nace con un "Viaje 1" para respetar la regla de que siempre existe un viaje.
- Los códigos son de 12 caracteres sin ambiguos y se entregan una sola vez.
- Un código inexistente da 401 y el de un espacio desactivado da 403 con su motivo (cambio posterior: ver la resolución del código).
- Las rutas de administración devuelven 404 (no 403) a quien no es administrador.
- `rates` y `settings` siguen globales.
