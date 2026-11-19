# Espacios por código: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada grupo entre con su propio código y vea solo su espacio, con una pantalla de administrador para crear, regenerar y desactivar espacios; y que un usuario nuevo vea el acceso al código de inmediato, sin ver antes parte de la app.

**Architecture:** Tabla `spaces`; columna `space_id` en `people`, `trips` y `payment_methods` (gastos, abonos y beneficiarios heredan por su viaje). `handle()` resuelve el espacio desde el código una sola vez y cada función del servidor recibe el id del espacio y filtra por él. El cliente descarta su copia local cuando cambia el espacio. El primer arranque sin código muestra el acceso de inmediato.

**Tech Stack:** Node >= 22.9 sin dependencias de servidor (`node:sqlite` local, `@libsql/client` en Turso), módulos ES, pruebas con `node --test`, cliente en JS sin framework.

**Spec:** `docs/superpowers/specs/2026-11-19-espacios-por-codigo-design.md`. La Tarea 1 no está en el spec: sale de un aviso del usuario durante el diseño (ver su descripción).

## Global Constraints

- Ningún archivo de código pasa de 700 líneas (`test/shell.test.mjs` lo comprueba). `src/handlers.mjs` tiene 655: la Tarea 3 le quita código y las siguientes le agregan poco.
- Textos de la app, mensajes de error y comentarios, en español.
- `APP_PASSCODE` sigue siendo el código del espacio administrador y se compara tal cual (sin normalizar). Sin `APP_PASSCODE` y sin código, la petición va al espacio administrador, como hoy.
- Códigos de espacio: 12 caracteres del alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, escritos en grupos de 4 (`K7M4-X9QD-H2RT`). Se guarda el SHA-256 hexadecimal del código normalizado (sin guiones ni espacios, en mayúsculas), nunca el código.
- Un código inexistente y uno de un espacio desactivado dan el mismo `401 'Código incorrecto'`.
- Quien no es administrador recibe `404 'Ruta no encontrada'` en `/api/spaces`.
- Un id de otro espacio da `404 'No encontrado'` al escribir, y se trata como inexistente al leer o referenciar.
- `rates` y `settings` siguen globales.
- Id fijo del espacio administrador: `space-admin`, nombre `Principal`.
- Comandos de prueba: `node --test --disable-warning=ExperimentalWarning <archivo>`; todo: `npm test`. Hoy pasan 163 pruebas y deben seguir pasando.
- Un commit por tarea, mensaje en español con prefijo (`feat:`, `fix:`), sin línea `Co-Authored-By` y sin `git push` (regla del usuario: solo si lo pide).
- No desplegar hasta terminar la Tarea 9, y antes hacer un respaldo JSON de producción (Ajustes, Respaldo). Entre las tareas 4 y 6 el aislamiento está a medias.

## Review Focus

Entradas que el spec implica pero que ninguna tarea probaría por sí sola, de más a menos probables:

1. **Código pegado con formato raro** (minúsculas, sin guiones, espacios o salto de línea al final). Debe entrar igual. Prueba en la Tarea 3.
2. **Espacio desactivado o con código regenerado mientras un celular tiene gastos en cola.** La cola se conserva, no se pierde ni se envía a otro espacio, y se envía al volver el acceso. Pruebas en la Tarea 8.
3. **`PUT` con el id de una fila de otro espacio** en cada recurso (personas, medios, viajes, gastos, abonos). No debe modificarla ni crear una copia. Pruebas en las tareas 4 y 5.
4. **El administrador mirando a los demás.** Ni `/api/state`, ni el respaldo, ni `/api/spaces` devuelven datos o hashes de otros espacios. Pruebas en las tareas 6 y 7.
5. **Cambiar `APP_PASSCODE` en Netlify.** El espacio administrador conserva su id y sus datos; solo cambia el código que entra. Prueba en la Tarea 3.

---

### Task 1: Primer arranque sin código muestra el acceso de inmediato

Hoy `net.needsLogin` arranca en `false`, así que `render()` dibuja la app (botón de viaje con "Viaje 1" por defecto, copia local o vacía) y la barra de pestañas, que es HTML fijo de `index.html`, está siempre visible. Solo cuando `sync()` recibe el 401 se pasa al acceso. La Tarea es no dibujar la app cuando se sabe de antemano que falta el código.

**Files:**
- Modify: `public/js/store.js` (constante `K`, `net`, `setPass`, `request`)
- Modify: `public/js/router.js` (`render`)
- Modify: `public/css/app.css` (regla nueva)
- Test: `test/store-login.test.mjs` (nuevo), `test/shell.test.mjs` (una prueba)

**Interfaces:**
- Produces: `net.needsLogin` arranca en `true` si no hay código guardado y el servidor no se marcó antes como abierto. Clave nueva `K.open = 'bg_open'` en `localStorage` (`'1'` = este servidor respondió sin pedir código). `body.logged-out` mientras `net.needsLogin` sea `true`.

- [ ] **Step 1: Escribir la prueba que falla** en `test/store-login.test.mjs`. Misma estructura que `test/store.test.mjs` (falso `localStorage` con un `Map`, `fetch` simulado, `delete process.env.APP_PASSCODE`). Cada escenario importa una instancia nueva del módulo con `await import('../public/js/store.js?caso=N')` y vacía el `Map` antes. Pruebas:
  - `'sin código guardado y servidor desconocido: pide el código desde el primer instante'`: `store.net.needsLogin === true` justo tras importar.
  - `'con código guardado: no pide el código al arrancar'`: `bg_pass = 'x'` antes de importar, `needsLogin === false`.
  - `'servidor ya marcado como abierto: no pide el código'`: `bg_open = '1'` y sin `bg_pass`, `needsLogin === false`.
  - `'una respuesta 200 sin código marca el servidor como abierto'`: arranca en `true`, `await store.ping()` con `fetch` que responde 200, luego `needsLogin === false` y `localStorage.getItem('bg_open') === '1'`.
  - `'un 401 vuelve a pedir el código y borra la marca'`: con `bg_open = '1'`, un `ping` con `fetch` que responde 401 deja `needsLogin === true` y `bg_open === null`.
  - `'setPass("") (cerrar sesión) borra la marca de abierto'`.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/store-login.test.mjs`
Expected: FAIL (el primer caso recibe `false`).

- [ ] **Step 3: Implementar en `store.js`.** Agregar `open: 'bg_open'` a `K`. Mover `getPass` por encima de `net` y calcular `needsLogin: !getPass() && localStorage.getItem(K.open) !== '1'`, dentro de `try/catch` (el almacenamiento puede fallar: en ese caso `true` si no hay código). En `request`, tras recibir una respuesta que no sea 401, si no hay código guardado, guardar `K.open = '1'` y poner `net.needsLogin = false` (con `notify()` si cambió). En el 401, borrar `K.open`. En `setPass`, si `p === ''`, borrar `K.open`.

- [ ] **Step 4: Ocultar la barra de pestañas** con el acceso a la vista. En `render()` de `router.js`, `document.body.classList.toggle('logged-out', store.net.needsLogin)` antes del `if (store.net.needsLogin)`. En `app.css`: `.logged-out .tabbar { display: none; }`. Agregar a `test/shell.test.mjs` la prueba `'la barra de pestañas se oculta mientras se pide el código'` que lee `public/css/app.css` y `public/js/router.js` y comprueba que existen la regla `.logged-out .tabbar` y el `classList.toggle('logged-out'`.

- [ ] **Step 5: Correr todo**

Run: `npm test`
Expected: todas pasan (las 163 de antes y las nuevas).

- [ ] **Step 6: Comprobar en el navegador** (`npm run dev` con `APP_PASSCODE=prueba` en `.env`): con el almacenamiento del sitio vacío, recargar. La primera imagen ya es el formulario de código, sin barra de pestañas ni botón de viaje. Con el código correcto entra; recargar no vuelve a mostrar el acceso.

- [ ] **Step 7: Commit**

```bash
git add public/js/store.js public/js/router.js public/css/app.css test/store-login.test.mjs test/shell.test.mjs
git commit -m "fix: sin código guardado se muestra el acceso de inmediato, sin dibujar la app antes"
```

---

### Task 2: Tabla `spaces`, columnas `space_id` y migración

**Files:**
- Modify: `src/schema.mjs` (tabla `spaces`, índice único, `space_id` en `people`, `trips`, `payment_methods`)
- Modify: `src/db.mjs` (función `upgradeSpaces`, llamada desde `open()`)
- Test: `test/spaces.test.mjs` (nuevo)

**Interfaces:**
- Produces: tabla `spaces(id, name, code_hash, is_admin, active, created_at)` con `CREATE UNIQUE INDEX IF NOT EXISTS spaces_code ON spaces(code_hash)`; columna `space_id TEXT REFERENCES spaces(id)` en `people`, `trips`, `payment_methods`. Existe siempre una fila `{ id: 'space-admin', name: 'Principal', code_hash: NULL, is_admin: 1, active: 1 }` y toda fila de esas tres tablas sin espacio queda con `space_id = 'space-admin'`. Constante `ADMIN_SPACE_ID` en `src/spaces.mjs` (se crea en la Tarea 3; aquí la migración usa el texto `'space-admin'` desde una constante local de `db.mjs` exportada como `ADMIN_SPACE_ID`, y la Tarea 3 la reexporta desde `spaces.mjs`).

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/spaces.test.mjs`:
  - `'migración: una base nueva tiene el espacio administrador y su viaje inicial le pertenece'`: con `openMemoryDb()`, `spaces` tiene una fila `space-admin` con `is_admin = 1`, `code_hash` nulo; `trips` tiene `trip-1` con `space_id = 'space-admin'`.
  - `'migración: una base anterior sin espacios conserva todo y lo asigna al administrador'`: crear un archivo SQLite temporal con `node:sqlite` (`DatabaseSync`) con las tablas `people`, `trips`, `payment_methods` en su forma anterior (sin `space_id`) y una fila en cada una; abrirlo con `openFileDb(file)`; comprobar que las tres filas siguen y tienen `space_id = 'space-admin'`. Seguir el patrón de la prueba de migración existente en `test/api.test.mjs` (buscar `openFileDb`).
  - `'migración: es idempotente'`: abrir el mismo archivo dos veces; sigue habiendo una sola fila de administrador y los mismos datos.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces.test.mjs`
Expected: FAIL (no existe la tabla `spaces`).

- [ ] **Step 3: Implementar.** En `schema.mjs`: agregar la tabla `spaces`, el índice único y `space_id` en las tres tablas (recordar: sin punto y coma dentro de los comentarios). En `db.mjs`: `async function upgradeSpaces(db)` que (a) agrega `space_id` con `ALTER TABLE ... ADD COLUMN` a las tres tablas si falta (mismo patrón que `upgradeTrips`), (b) hace `INSERT OR IGNORE` del espacio administrador con `created_at = new Date().toISOString()`, (c) `UPDATE ... SET space_id = ? WHERE space_id IS NULL` en las tres. Llamarla en `open()` después de `upgradeTrips` (que puede crear `trip-1` sin espacio) y antes de `dropDerivedColumns`.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add src/schema.mjs src/db.mjs test/spaces.test.mjs docs/superpowers/specs docs/superpowers/plans
git commit -m "feat: tabla de espacios y migración que asigna lo existente al administrador"
```

---

### Task 3: Resolver el espacio desde el código

Se mueve el control de acceso fuera de `handlers.mjs` (queda más corto) y se agrega la búsqueda del código en `spaces`.

**Files:**
- Create: `src/errors.mjs`, `src/auth.mjs`, `src/spaces.mjs`
- Modify: `src/handlers.mjs` (quitar `HttpError`, `fail`, `text`, `sha`, `isAuthorized`, `ipKey`, `countAttempt`, `checkAuth` y las constantes `MAX_FAILS`, `MAX_GLOBAL`, `LOCK_MS`; importarlos; `handle()` usa el espacio)
- Test: `test/spaces.test.mjs`

**Interfaces:**
- `src/errors.mjs`: `export class HttpError extends Error { status }`, `export const fail = (status, message) => never`, `export function text(value, label, { max = 80, required = true } = {})` (mismo comportamiento que hoy).
- `src/spaces.mjs` (en esta tarea solo lo de códigos): `export const ADMIN_SPACE_ID = 'space-admin'`; `export function generateCode(): string` (`XXXX-XXXX-XXXX`, con `crypto.randomInt`); `export function normalizeCode(raw: unknown): string`; `export function hashCode(raw: unknown): string`; `export async function findSpaceByCode(db, raw): Promise<Space | null>` solo espacios con `active = 1`. Tipo `Space = { id: string, name: string, is_admin: boolean }`.
- `src/auth.mjs`: `export async function checkAuth(db, passcode, ip): Promise<Space>`; mismo conteo de intentos, mismos límites (10 por red y 300 globales cada 15 min) y mismos mensajes que hoy.
- `handle({ ..., passcode, ip, db })` obtiene `const space = await checkAuth(...)` y calcula `const sp = space.id`. En esta tarea las funciones aún no filtran; `GET /api/ping` devuelve `{ ok: true, space: { id, name, is_admin } }`.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/spaces.test.mjs` (con `process.env.APP_PASSCODE = 'secreto'` y `finally { delete ... }` como en las pruebas existentes). Para crear espacios de prueba, insertar filas con `db.run` usando `hashCode`:
  - `'generateCode: 12 caracteres del alfabeto sin ambiguos, en grupos de 4'`: coincide con `/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){2}$/` en 200 códigos, y no se repiten.
  - `'normalizeCode y hashCode: minúsculas, sin guiones, espacios ni salto de línea dan el mismo hash'`: `hashCode(' k7m4-x9qd h2rt\n') === hashCode('K7M4X9QDH2RT')`.
  - `'el código del administrador (APP_PASSCODE) entra al espacio administrador'`: `GET /api/ping` con `passcode: 'secreto'` devuelve `space.is_admin === true`.
  - `'un código de espacio activo entra a su espacio, escrito de cualquier forma'`: con la fila insertada, `passcode` en minúsculas y sin guiones devuelve `space.id` del espacio y `is_admin === false`.
  - `'espacio desactivado y código inexistente dan la misma respuesta'`: ambos `401` con `body.error === 'Código incorrecto'`.
  - `'el límite de intentos sigue valiendo con espacios'`: 10 intentos malos desde una IP dan `401` y el siguiente `429`, igual que la prueba de seguridad existente; acertar con un código de espacio desde otra IP da `200`.
  - `'sin APP_PASSCODE y sin código: espacio administrador'` y `'sin APP_PASSCODE, un código de espacio activo entra a ese espacio'`.
  - `'cambiar APP_PASSCODE conserva el espacio administrador'`: con `'uno'`, crear una persona; con `'dos'` el mismo espacio (`space.id === 'space-admin'`) sigue viendo esa persona.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces.test.mjs`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar** `errors.mjs`, `spaces.mjs` (códigos y `findSpaceByCode`), `auth.mjs` (mover el control de intentos; con `APP_PASSCODE` definido: sin código, `401`; contar el intento antes de comparar; primero comparar con `APP_PASSCODE` en tiempo constante, si no, `findSpaceByCode`; acierto limpia el conteo igual que hoy; fallo, `401 'Código incorrecto'`. Sin `APP_PASSCODE`: sin código o sin coincidencia, espacio administrador; con coincidencia, ese espacio). `handlers.mjs` importa lo movido y `backup.mjs` sigue recibiendo `fail` inyectado.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan; `handlers.mjs` queda por debajo de 600 líneas.

- [ ] **Step 5: Commit**

```bash
git add src/errors.mjs src/auth.mjs src/spaces.mjs src/handlers.mjs test/spaces.test.mjs
git commit -m "feat: el código de acceso resuelve el espacio (administrador, activo o rechazado)"
```

---

### Task 4: Aislar viajes, personas, medios de pago y el estado

**Files:**
- Create: `src/scope.mjs`
- Modify: `src/handlers.mjs` (`getTrip`, `saveTrip`, `deleteTrip`, `savePerson`, `deletePerson`, `saveMethod`, `deleteMethod`, `getState`, `fillPendingRates`, `fillPendingRatesOf`, `put` y las rutas `rates/history` y `rate`)
- Test: `test/isolation.test.mjs` (nuevo)

**Interfaces:**
- Consumes: `checkAuth`, `fail` (Tarea 3).
- Produces en `src/scope.mjs`, con `table` entre `'people' | 'trips' | 'payment_methods' | 'expenses' | 'payments'` (los gastos y abonos se asocian al espacio por su viaje):
  - `export async function owns(db, table, id, sp): Promise<boolean>` — la fila existe y es del espacio `sp`.
  - `export async function assertNotForeign(db, table, id, sp): Promise<void>` — lanza `fail(404, 'No encontrado')` si la fila existe y es de otro espacio; no hace nada si no existe o es propia.
  - `export async function ownedIds(db, table, ids, sp): Promise<Set<string>>` — cuáles de `ids` son del espacio.
- Convención nueva en `handlers.mjs`: toda función de dominio recibe `sp` como segundo parámetro: `getTrip(db, sp, id)`, `saveTrip(db, sp, id, body)`, `getState(db, sp, space)`, etc. `put(fn)` llama `fn(db, sp, id, body)`.

Reglas por función:
- `getTrip`: con id, `WHERE id = ? AND space_id = ?`; sin id, el primer viaje de **ese espacio**; si no hay, `400 'El viaje no existe'` como hoy.
- `saveTrip`: `assertNotForeign('trips')` primero; personas existentes y la lista por defecto del viaje nuevo solo del espacio; el `INSERT` guarda `space_id`; el `ON CONFLICT DO UPDATE` no toca `space_id`.
- `deleteTrip`: la lista de viajes y la regla "no se puede borrar el único" son por espacio; un id ajeno no hace nada.
- `savePerson`: `assertNotForeign('people')`; el viaje de `body.trip_id` por `getTrip`; sin viaje, entra en todos los viajes **del espacio**; el `INSERT` guarda `space_id`.
- `deletePerson` y `deleteMethod`: un id ajeno no hace nada.
- `saveMethod`: `assertNotForeign('payment_methods')`; el dueño debe ser del espacio (si no, `400 'El dueño no existe'`); el `INSERT` guarda `space_id`.
- `getState`: cada consulta filtra por espacio (gastos, abonos y vínculos por su viaje) y la respuesta agrega `space: { id, name, is_admin }` con `is_admin` booleano. `fillPendingRatesOf` solo revisa filas de viajes del espacio.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/isolation.test.mjs`. Ayuda local al archivo (no crear otro archivo en `test/`, porque `node --test` ejecutaría cualquier `.mjs` allí): `async function twoSpaces()` que abre `openMemoryDb()`, crea dos espacios insertando filas con `hashCode` (más un viaje propio y una persona en cada uno, por `handle` con su código) y devuelve `{ db, A, B }` donde cada uno es `(method, path, body, query?) => handle({ ..., passcode: <su código>, db })`. Pruebas:
  - `'estado: cada espacio ve solo lo suyo, incluido el administrador'`: el estado de A no contiene viajes, personas ni medios de B, y el del administrador no contiene los de A ni los de B; `state.space` trae el id propio y `is_admin` correcto.
  - `'un espacio nuevo sin datos recibe su propio primer viaje al pedir sin id'`: `getTrip` sin id nunca devuelve el viaje de otro espacio (probar con `GET /api/rate` sin `?trip=` en un espacio con un solo viaje propio: usa las monedas de ese viaje).
  - `'PUT con el id de otro espacio no modifica ni copia: personas, medios y viajes'`: B hace `PUT /api/people/<id de A>`, `PUT /api/payment-methods/<id de A>` y `PUT /api/trips/<id de A>`; cada respuesta es `404`, y las filas de A quedan idénticas (comparar `db.all` antes y después) y no aparece ninguna fila nueva en B.
  - `'borrar con un id ajeno no borra'`: B hace `DELETE` de una persona, un medio y un viaje de A; A conserva los tres.
  - `'un medio de pago no puede tener como dueño a una persona de otro espacio'`: `400`.
  - `'un viaje no puede incluir personas de otro espacio'`: `400 'Alguna persona no existe'`.
  - `'no se puede borrar el único viaje de un espacio aunque otros espacios tengan viajes'`: `400`.
  - `'con APP_PASSCODE definido, un espacio no ve lo del administrador'` (Review Focus 4, parte del estado).

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/isolation.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar** `scope.mjs` y los cambios de `handlers.mjs` según las reglas de arriba.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan (las pruebas anteriores usan el espacio administrador y no cambian).

- [ ] **Step 5: Commit**

```bash
git add src/scope.mjs src/handlers.mjs test/isolation.test.mjs
git commit -m "feat: viajes, personas, medios de pago y estado se filtran por espacio"
```

---

### Task 5: Aislar gastos, abonos, orden y tasas

**Files:**
- Modify: `src/handlers.mjs` (`saveExpense`, `deleteExpense`, `saveOrder`, `savePayment`, `deletePayment`, `refreshTripRates` y las rutas que usan `getTrip`)
- Test: `test/isolation.test.mjs`

**Interfaces:**
- Consumes: `owns`, `assertNotForeign`, `ownedIds` (Tarea 4), `getTrip(db, sp, id)`.

Reglas:
- `saveExpense`: `assertNotForeign('expenses')` antes de leer el viaje previo; el medio de pago, el medio de relleno de "por definir" y los beneficiarios se buscan solo entre los del espacio (un id ajeno es "no existe": `400 'El medio de pago no existe'` / `400 'Alguna persona no existe'`).
- `saveOrder`: solo actualiza gastos de viajes del espacio; ids ajenos se ignoran, como los inexistentes.
- `deleteExpense`, `deletePayment`: un id ajeno no hace nada.
- `savePayment`: `assertNotForeign('payments')`; el viaje por `getTrip`; las personas ya se validan contra el viaje.
- `refreshTripRates`: usa `getTrip(db, sp, ...)`; no toca gastos de otros espacios.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/isolation.test.mjs`, con la ayuda `twoSpaces()` y un gasto y un abono ya creados en A:
  - `'PUT con el id de un gasto o abono de otro espacio da 404 y no lo toca'` (Review Focus 3): fila de A idéntica antes y después, y B sin filas nuevas.
  - `'un gasto con medio de pago, beneficiario o viaje de otro espacio se rechaza'`: tres casos, cada uno `400`.
  - `'un abono entre personas de otro espacio o en un viaje ajeno se rechaza'`.
  - `'POST /api/order de B con ids de gastos de A no cambia su orden'`.
  - `'DELETE de un gasto y un abono de A hecho por B no los borra'`.
  - `'actualizar tasas en B no cambia los gastos de A'` (con la fuente simulada como `withSource` de `test/backup.test.mjs`, copiando su definición al archivo).

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/isolation.test.mjs`
Expected: FAIL (los casos nuevos).

- [ ] **Step 3: Implementar** según las reglas.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add src/handlers.mjs test/isolation.test.mjs
git commit -m "feat: gastos, abonos, orden y tasas se filtran por espacio"
```

---

### Task 6: Aislar respaldo y restauración, y barrido de todas las rutas

**Files:**
- Modify: `src/backup.mjs`, `src/handlers.mjs` (las dos rutas)
- Test: `test/isolation.test.mjs`, `test/backup.test.mjs` (adaptar llamadas)

**Interfaces:**
- Consumes: `fail` inyectado como hoy.
- Produces: `export async function dumpBackup(db, sp): Promise<Backup>` y `export async function restoreBackup(db, sp, data, { dry, fail }): Promise<{ dry, add, skip }>`. El formato del archivo (`app`, `version: 1`, tablas) no cambia, y el respaldo nunca trae la tabla `spaces` ni `space_id`.

Reglas:
- `dumpBackup`: solo filas del espacio (gastos, abonos, vínculos y `trip_people` por su viaje).
- `restoreBackup`: `have[...]` son los ids que ya existen **en ese espacio**. Se carga además el conjunto de ids que existen en otros espacios (en cualquier tabla); si un id del archivo está allí, falla con `400` de datos inválidos (mismo mensaje que los demás errores del respaldo, sin decir de quién es) y no se escribe nada. Las referencias se comprueban solo contra el espacio, así que un viaje, persona o medio de otro espacio cuenta como inexistente. Los `INSERT` de `people`, `trips` y `payment_methods` guardan `space_id = sp`. El mapa de dueños de medios (`owners`) sale solo del espacio.

- [ ] **Step 1: Adaptar `test/backup.test.mjs`** para llamar `dumpBackup(db, 'space-admin')` y `restoreBackup(db, 'space-admin', ...)` donde use las funciones directamente (las pruebas por `handle` no cambian).

- [ ] **Step 2: Escribir las pruebas que fallan** en `test/isolation.test.mjs`:
  - `'el respaldo de A no trae nada de B ni la tabla spaces'`: tampoco `space_id` ni `code_hash`.
  - `'restaurar en B un respaldo de A copia los datos como nuevos de B solo si los ids no existen en otros espacios'`: dos casos: (a) con los ids de A todavía en A, `POST /api/restore` de B responde `400` y no escribe nada; (b) un respaldo con ids nuevos entra completo y aparece en el estado de B y no en el de A.
  - `'restaurar con dry=1 no revela ni cuenta filas de otro espacio'`.
  - **Barrido** `'ninguna ruta devuelve ni modifica datos de otro espacio'`: tabla de rutas `[método, ruta]` con las de `handle` (`state`, `trips`, `people`, `payment-methods`, `expenses`, `payments`, `order`, `rates/history`, `rates/refresh`, `rate`, `backup`, `restore`, `ping`), usando ids de A desde B. Para cada una: la respuesta serializada no contiene ninguna cadena sensible de A (nombres y ids sembrados) y el volcado de las tablas de A es idéntico antes y después.

- [ ] **Step 3: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/isolation.test.mjs test/backup.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implementar** según las reglas.

- [ ] **Step 5: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 6: Commit**

```bash
git add src/backup.mjs src/handlers.mjs test/isolation.test.mjs test/backup.test.mjs
git commit -m "feat: respaldo y restauración por espacio y prueba de aislamiento de todas las rutas"
```

---

### Task 7: Rutas de administración de espacios

**Files:**
- Modify: `src/spaces.mjs`, `src/handlers.mjs` (rutas `/api/spaces`)
- Test: `test/spaces.test.mjs`

**Interfaces:**
- Consumes: `generateCode`, `hashCode` (Tarea 3), `text` y `fail` (`errors.mjs`), `DEFAULT_SETTINGS` de `public/js/currencies.mjs`.
- Produces en `src/spaces.mjs` (todas devuelven el cuerpo de la respuesta):
  - `listSpaces(db): Promise<Array<{ id, name, created_at, active: boolean, is_admin: boolean }>>`, administrador primero y luego por `created_at`.
  - `createSpace(db, body): Promise<{ id, name, code }>` — `body.name` obligatorio, máximo 40 caracteres; crea el espacio y un viaje "Viaje 1" con las monedas por defecto (id propio con `randomUUID()`); el `code` se devuelve solo aquí.
  - `regenerateSpace(db, id): Promise<{ id, code }>` — el código anterior deja de servir.
  - `setSpaceActive(db, id, body): Promise<{ id, active: boolean }>` — `body.active` booleano.
  - Sobre el espacio administrador, `regenerateSpace` y `setSpaceActive` dan `400 'El espacio administrador no se puede cambiar'`; sobre un id inexistente, `404 'No encontrado'`.
- Rutas: `GET /api/spaces`, `POST /api/spaces` (201), `POST /api/spaces/:id/regenerate`, `PUT /api/spaces/:id`. Si `space.is_admin` es falso: `404 'Ruta no encontrada'`.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/spaces.test.mjs`:
  - `'solo el administrador usa /api/spaces: los demás reciben 404'` (las cuatro rutas, con el código de un espacio normal).
  - `'crear: devuelve el código una sola vez y el espacio entra con él'`: `POST` devuelve `201` y `code` con el formato; entrar con ese código da `200` y `space.id` igual al creado; el nuevo espacio ya trae un viaje ("Viaje 1") y el administrador no lo ve en su estado.
  - `'listar: nunca incluye código ni hash, ni datos de los espacios'`: `JSON.stringify(body)` no contiene `code` ni `hash` y las claves de cada elemento son exactamente `id, name, created_at, active, is_admin`.
  - `'regenerar: el código anterior falla y el nuevo entra'` (Review Focus 2, lado servidor).
  - `'desactivar: el espacio no entra, sus datos siguen; al reactivar vuelve todo'`: crear una persona en el espacio, desactivar, entrar da `401`, reactivar, la persona sigue.
  - `'el espacio administrador no se puede regenerar ni desactivar'` (`400`).
  - `'nombre vacío o de más de 40 caracteres: 400'`.
  - `'dos espacios creados tienen códigos distintos y ninguno entra al otro'`.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar** las cuatro funciones y las rutas.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add src/spaces.mjs src/handlers.mjs test/spaces.test.mjs
git commit -m "feat: el administrador crea, regenera y desactiva espacios"
```

---

### Task 8: El cliente descarta su copia local al cambiar de espacio

**Files:**
- Modify: `public/js/store.js`, `public/js/events.js` (rama `login`)
- Test: `test/store-space.test.mjs` (nuevo)

**Interfaces:**
- Consumes: `ping` ahora devuelve `{ ok: true, space: { id, name, is_admin } }`; `GET /api/state` trae `space` con la misma forma.
- Produces en `store.js` (clave nueva `K.space = 'bg_space'`):
  - `export const getPass: () => string` (ahora exportada).
  - `export function discardCount(space): number` — cuántos gastos sin enviar se perderían al entrar en `space` (0 si es el mismo espacio, o si no se conoce el anterior y `space.is_admin` es verdadero).
  - `export function adoptSpace(space): boolean` — si cambió el espacio (o no se conocía el anterior, hay datos locales y `!space.is_admin`, porque los datos anteriores a los espacios eran del administrador), borra de la copia local y de memoria el estado, la cola, las tasas, el historial y el viaje activo; guarda `K.space = space.id`; devuelve `true` si borró.
  - `refresh()` llama a `adoptSpace(fresh.space)` antes de aplicar el estado recibido.
  - `flush()` ya se detiene en el 401: no cambia.
- La rama `login` de `events.js`: guarda el código anterior (`getPass()`), pone el nuevo, hace `ping`; con `n = store.discardCount(info.space)` mayor que cero, `confirm` con el texto `Hay ${n} gasto(s) sin enviar del espacio anterior. Si entras con este código se descartarán. ¿Continuar?`; si cancela, restaura el código anterior con `setPass` y no sigue; si acepta, `store.adoptSpace(info.space)` y luego `refresh` y `flush` como hoy.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/store-space.test.mjs` (falso `localStorage` y `fetch` sobre `handle` con `openMemoryDb()` como en `test/store.test.mjs`, dos espacios creados por filas con `hashCode`, `APP_PASSCODE` definido, instancia nueva del módulo por escenario con `import('../public/js/store.js?caso=N')`):
  - `'cambiar de espacio borra estado, cola, tasas, historial y viaje activo'`: entrar en A, guardar un gasto sin conexión (queda en cola), cambiar el código por el de B y refrescar: `store.pendingCount() === 0` y el estado no contiene nada de A.
  - `'volver a entrar en el mismo espacio conserva todo, incluida la cola'`.
  - `'discardCount: cuenta la cola solo si cambia el espacio'`.
  - `'copia anterior a los espacios y entrada con un espacio normal: se descarta'` y `'... y entrada como administrador: se conserva'`.
  - `'espacio desactivado con gastos en cola: la cola se conserva y se envía al reactivar'` (Review Focus 2): con `flush()` en `401` la cola queda intacta; al reactivar y volver a entrar con el mismo código, se envía una sola vez.
  - `'código regenerado: la cola se conserva; entrar con el código nuevo del mismo espacio no la borra'`.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/store-space.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar** en `store.js` y en la rama `login` de `events.js`.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add public/js/store.js public/js/events.js test/store-space.test.mjs
git commit -m "feat: el celular descarta su copia local al entrar en otro espacio"
```

---

### Task 9: Sección Espacios en Ajustes, README y service worker

**Files:**
- Create: `public/js/spaces-card.mjs` (HTML puro, sin tocar `document`), `public/js/view-spaces.js` (estado de la sección y carga)
- Modify: `public/js/store.js` (llamadas), `public/js/view-settings.js` (insertar la tarjeta), `public/js/events.js` (acciones y envío del formulario), `public/css/screens.css`, `public/sw.js` (agregar los dos módulos a `SHELL` y subir `CACHE` a `gastos-viaje-v113`), `README.md`
- Test: `test/spaces-card.test.mjs` (nuevo), `test/shell.test.mjs` (ya exige que `SHELL` liste los módulos)

**Interfaces:**
- Consumes: rutas de la Tarea 7; `state.space` en `ctx().state.space`.
- Produces en `store.js`: `listSpaces(): Promise<Space[]>`, `createSpace(name): Promise<{ id, name, code }>`, `regenerateSpace(id): Promise<{ id, code }>`, `setSpaceActive(id, active): Promise<{ id, active }>`; no refrescan el estado (no cambian lo que ve el administrador).
- `spaces-card.mjs`: `export function spacesCardHtml({ spaces, shown, esc }): string` donde `spaces` es el arreglo de `listSpaces` (o `null` mientras carga) y `shown` es `{ name, code } | null` (el código recién creado o regenerado, mostrado una sola vez).
- Acciones en `events.js` (`data-action`): `new-space` (abre el diálogo con el nombre), `copy-code`, `share-code` (usa `navigator.share` si existe), `regen-space` y `toggle-space`, estas dos con `confirm`. Formulario `space-form`. Los errores se muestran dentro del diálogo, como los demás.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/spaces-card.test.mjs` (importa solo `spaces-card.mjs`, pasando `esc` como argumento):
  - `'la tarjeta lista nombre, fecha y estado de cada espacio'`.
  - `'el espacio administrador no tiene botones de regenerar ni desactivar'`.
  - `'el código recién creado se muestra con aviso de que no se vuelve a ver y botones de copiar y compartir'`; sin `shown`, el código no aparece.
  - `'un nombre con HTML se escapa'`: `<b>x</b>` no sale sin escapar.
  - `'mientras carga (spaces = null) muestra un texto de carga y el botón de crear'`.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces-card.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar** `spaces-card.mjs`, `view-spaces.js`, las funciones de `store.js`, la inserción en `view-settings.js` (solo si `c.state.space?.is_admin`; la lista se carga al entrar en Ajustes y tras cada acción), las acciones en `events.js`, estilos mínimos en `screens.css` que reutilicen las clases `card`, `pay row`, `btn` y `tag` de la tarjeta de Viajes, y el service worker. En el README: nueva sección "Varios grupos (espacios)" que explique la sección Espacios, que `APP_PASSCODE` es el código del administrador y sirve de respaldo, que el código de cada grupo solo se ve al crearlo o regenerarlo, y el aviso de hacer un respaldo antes de desplegar esta versión.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan, incluidas las de `shell.test.mjs` (módulos en `SHELL`, ningún archivo sobre 700 líneas).

- [ ] **Step 5: Comprobar en el navegador** (`npm run dev` con `APP_PASSCODE=prueba`): entrar como administrador, crear "Familia Prueba", copiar el código; en una ventana privada entrar con ese código y ver que no aparecen los viajes del administrador ni la sección Espacios; regenerar el código y confirmar que el anterior ya no entra; desactivar y reactivar. Revisar el diálogo y la lista a 390 px de ancho.

- [ ] **Step 6: Commit**

```bash
git add public README.md test/spaces-card.test.mjs
git commit -m "feat: sección Espacios en Ajustes para crear, regenerar y desactivar grupos"
```

---

## Self-review

- **Cobertura del spec:** datos y migración (T2); resolución del código, `APP_PASSCODE` como respaldo y mismo error para inexistente o desactivado (T3); aislamiento de cada ruta, ids ajenos, referencias cruzadas, `getTrip` por espacio, tasas y respaldo (T4 a T6); administración, formato de códigos, "Viaje 1" inicial, 404 a no administradores y administrador sin acceso a datos ajenos (T7); cambio de código en un celular y aviso con cola sin enviar (T8); pantalla, README y service worker (T9); pruebas de aislamiento (T4 a T6). Añadido: T1, por el aviso del usuario.
- **Decisiones del plan que no están en el spec:** `is_admin` aparece también en la lista de espacios (la pantalla lo necesita para no ofrecer acciones sobre el administrador); `ping` devuelve el espacio (el acceso lo necesita antes de refrescar); el espacio administrador se llama `Principal`; SHA-256 simple del código normalizado, sin sal ni HMAC (el código es aleatorio de 12 caracteres y no una clave elegida); `K.open` en el cliente para no mostrar el acceso en cada recarga de un servidor sin `APP_PASSCODE`.
- **Consistencia de nombres:** `checkAuth`, `findSpaceByCode`, `owns`, `assertNotForeign`, `ownedIds`, `adoptSpace`, `discardCount`, `ADMIN_SPACE_ID` se definen en la tarea que los produce y las siguientes los usan con esa firma.
