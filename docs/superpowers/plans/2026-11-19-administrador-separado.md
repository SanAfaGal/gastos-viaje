# Administrador separado de los datos: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un código de administrador (`ADMIN_PASSCODE`) que solo gestiona espacios y no abre ningún dato, con el espacio del dueño ("Principal") convertido en un espacio igual a los demás, y poder renombrar espacios.

**Architecture:** `checkAuth` devuelve ahora una identidad `Space = { id, name, is_principal, is_manager }`: o un espacio de datos (por hash de su código) o la administración (`id: 'manager'`, sin fila en `spaces` ni datos). `handle()` deja pasar a la administración solo por `ping`, `state` y `/api/spaces`. `APP_PASSCODE` solo siembra, en la primera entrada, el hash del código de Principal. El cliente muestra a la administración una sola pantalla.

**Tech Stack:** Node >= 22.9 sin dependencias de servidor, `node:sqlite` local y Turso en línea, JS de navegador sin framework, pruebas con `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-19-administrador-separado-design.md` (parte de `2026-11-19-espacios-por-codigo-design.md`, ya implementado).

## Global Constraints

- Rama nueva `feat/administrador-separado`, creada desde `main` con el árbol limpio. Un commit por tarea, mensaje en español con prefijo (`feat:`, `fix:`, `docs:`), **sin** línea `Co-Authored-By` y **sin** `git push`. No staged `.superpowers/`.
- Ningún archivo de código pasa de 700 líneas (`test/shell.test.mjs` lo comprueba). `test/isolation.test.mjs` está en 699: no puede crecer; las pruebas nuevas van en archivos nuevos y los cambios de nombre de claves dentro de él deben dejar el mismo número de líneas o menos.
- Textos de la app, mensajes de error y comentarios, en español.
- Ids fijos: Principal `space-admin` (id histórico, sin migración); administración `manager`. La columna `spaces.is_admin` se conserva sin leerse para decidir nada.
- Claves de la API: `state.space = { id, name, is_principal, is_manager }`. La lista de `/api/spaces` devuelve exactamente `id, name, created_at, active`. Ninguna respuesta lleva `is_admin`.
- Respuestas de acceso: sin código o código inexistente `401 'Código incorrecto'`; código exacto de un espacio desactivado `403 'Este espacio está desactivado. Habla con quien te dio el código.'` sin gastar intentos; sin permiso para la ruta `404 'Ruta no encontrada'`.
- La app pide código si está definida `ADMIN_PASSCODE` **o** `APP_PASSCODE`. Solo sin ninguna de las dos queda abierta (todos entran a Principal, sin administración). `ADMIN_PASSCODE` gana si coincide con el código de un espacio.
- Comandos de prueba: `node --test --disable-warning=ExperimentalWarning <archivo>`; todo: `npm test`. Hoy pasan 292 pruebas; deben seguir pasando salvo las que esta tarea reescribe expresamente.
- Las pruebas que cambian `process.env.APP_PASSCODE` o `ADMIN_PASSCODE` lo restauran en `finally`.

## Review Focus

1. **`ADMIN_PASSCODE` igual al código de un espacio** (por ejemplo copiado de uno). Debe ganar el administrador y no abrir datos. Prueba en la Tarea 1.
2. **Solo `APP_PASSCODE` definida (se olvidó `ADMIN_PASSCODE` en producción).** La app NO queda abierta: sin código da 401. Prueba en la Tarea 1.
3. **La administración probando todas las rutas de datos con ids reales de otro espacio.** Todas dan 404 y nada cambia. Barrido en la Tarea 1.
4. **Un celular de administración no pide ni envía datos** (tasas, cola, copia local). Prueba en la Tarea 4.
5. **Principal desactivado o con código regenerado mientras un celular tiene gastos sin enviar.** Se conserva la cola y sale el motivo correcto. Prueba en la Tarea 1 (servidor) reutilizando las reglas del cliente ya existentes.

---

### Task 1: Identidades: administración, Principal como espacio normal y claves nuevas

**Files:**
- Modify: `src/spaces.mjs`, `src/auth.mjs`, `src/handlers.mjs`, `public/js/store.js` (una línea, regla de copias antiguas)
- Create: `test/manager.test.mjs`
- Modify (solo nombres de claves y de variable de entorno en los helpers): `test/spaces.test.mjs`, `test/auth-espacios.test.mjs`, `test/isolation.test.mjs`, `test/isolation-writes.test.mjs`, `test/spaces-card.test.mjs`, `test/store-space.test.mjs`, `test/api.test.mjs` y cualquier otra que falle

**Interfaces:**
- Produces en `src/spaces.mjs`:
  - `MANAGER_SPACE: Space` = `{ id: 'manager', name: 'Administración', is_principal: false, is_manager: true }` (constante exportada).
  - `findSpaceByCode(db, raw): Promise<Space | null>` solo espacios activos; devuelve `{ id, name, is_principal: id === ADMIN_SPACE_ID, is_manager: false }`.
  - `isInactiveSpaceCode(db, raw): Promise<boolean>` sin el filtro `is_admin = 0` (Principal desactivado también da el 403).
  - `getPrincipalSpace(db): Promise<Space>` (reemplaza a `getAdminSpace`; se usa en modo abierto).
  - `seedPrincipalCode(db, raw): Promise<void>`: guarda `hashCode(raw)` como `code_hash` de `space-admin` con una sola sentencia `UPDATE ... WHERE id = ? AND code_hash IS NULL AND NOT EXISTS (SELECT 1 FROM spaces WHERE code_hash = ?)`; no hace nada si `normalizeCode(raw)` es vacío.
  - `listSpaces(db): Promise<Array<{ id, name, created_at, active: boolean }>>`, orden `created_at, rowid`, sin `code_hash` ni `is_admin`.
  - `regenerateSpace` y `setSpaceActive` aceptan cualquier espacio existente (Principal incluido); id inexistente `404 'No encontrado'`. Ya no existe el mensaje "El espacio administrador no se puede cambiar".
- Produces en `src/auth.mjs`: `checkAuth(db, passcode, ip): Promise<Space>` con las reglas de Global Constraints. Un acierto de `ADMIN_PASSCODE` borra la fila de la red en `auth_failures`; cualquier otro acierto solo descuenta ese intento (propio y global).
- Produces en `src/handlers.mjs`: si `space.is_manager`, `handle()` responde `404 'Ruta no encontrada'` a todo salvo `ping`, `state` y `spaces` (antes de leer el cuerpo o tocar la base). Para un espacio de datos `/api/spaces` da 404. El estado de la administración es `{ today, space, trips: [], people: [], payment_methods: [], expenses: [], payments: [] }` sin consultar tablas de datos; el de un espacio lleva `space: { id, name, is_principal, is_manager: false }`.

- [ ] **Step 1: Escribir las pruebas que fallan** en `test/manager.test.mjs` (con el patrón de helpers de `test/spaces.test.mjs`: base en memoria, espacios por filas con `hashCode`, `try/finally` para el entorno):
  - `'ADMIN_PASSCODE entra como administración: estado vacío, sin consultar datos'`: `GET /api/state` da `space.is_manager === true`, `space.id === 'manager'` y las cinco listas vacías aunque Principal tenga viajes y personas.
  - `'la administración recibe 404 en cada ruta de datos y no cambia nada'`: barrido con ids reales de Principal y de otro espacio (viajes, personas, medios, gastos, abonos, orden, tasas history/refresh/rate, respaldo, restauración, resolve-place) y snapshot de todas las tablas antes y después.
  - `'un código de espacio recibe 404 en /api/spaces; sin ADMIN_PASSCODE también con cualquier código'`.
  - `'solo APP_PASSCODE definida: la app no queda abierta'`: sin código `401`; con un código malo `401`.
  - `'sin ninguna variable: abierta, todos entran a Principal y no hay administración'`.
  - `'ADMIN_PASSCODE igual al código de un espacio: gana el administrador'` (Review Focus 1): el estado es de administración y vacío.
  - `'siembra: la primera entrada con APP_PASSCODE deja a Principal con ese hash y entra'`; `'entrar otra vez no cambia nada'`; `'cambiar APP_PASSCODE después de sembrar no cambia el código de Principal: el nuevo valor ya no entra y el anterior sí'`; `'un Principal que ya tiene código no se pisa (APP_PASSCODE deja de entrar)'`; `'APP_PASSCODE que se reduce a vacío (---) no siembra'`; `'un código de otro espacio nunca siembra'`; `'con Principal desactivado la primera entrada siembra y da 403'`.
  - `'Principal se puede regenerar, desactivar (403 con motivo) y reactivar como cualquier espacio'`.
  - `'límite de intentos: acertar con un código de espacio intercalado entre fallos sigue llegando a 429; acertar con ADMIN_PASSCODE reinicia la red'`.
  - `'las claves: ninguna respuesta lleva is_admin; state.space lleva is_principal e is_manager; la lista de espacios no lleva ninguna de las dos'`.
  - `'espacio desactivado con cola en el celular: el servidor responde 403 y la cola del cliente se conserva'` (Review Focus 5): reutiliza el helper de `test/store-space.test.mjs` si es sencillo; si no, comprobar solo el 403.

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/manager.test.mjs`
Expected: FAIL (no existe `MANAGER_SPACE`, `seedPrincipalCode`, etc.).

- [ ] **Step 3: Implementar** `src/spaces.mjs` (firmas de Interfaces; `toSpace` calcula `is_principal` por el id, no por la columna), `src/auth.mjs` y `src/handlers.mjs` según Interfaces. Orden de decisión de `checkAuth` con la app protegida: sin código `401` sin contar; contar el intento antes de comparar; `ADMIN_PASSCODE` definida y código igual (sha256 + `timingSafeEqual`) gana; si no, `findSpaceByCode`; si no hay espacio, `APP_PASSCODE` definida y código igual (mismo comparador) siembra con `seedPrincipalCode` y se vuelve a buscar por hash; si sigue sin haber espacio, `isInactiveSpaceCode` da el 403 que no cuenta; si no, `401`. En `src/handlers.mjs` quitar la dependencia de `process.env.APP_PASSCODE` en la compuerta de `/api/spaces`: ahora basta `space.is_manager`.

- [ ] **Step 4: Adaptar las pruebas existentes** que usaban `APP_PASSCODE` como código de administrador de `/api/spaces` (helpers `conPasscode`/`admin` de `test/spaces.test.mjs` y `test/auth-espacios.test.mjs`) para que usen `ADMIN_PASSCODE`, y cambiar `is_admin` por `is_principal` o `is_manager` según corresponda en las demás. Reescribir expresamente estas pruebas, que ya no describen el comportamiento: `'cambiar APP_PASSCODE conserva el espacio administrador'` (ahora: ver la prueba de siembra), `'las rutas de espacios exigen APP_PASSCODE definido además de ser administrador'` (ahora: `is_manager`), `'el espacio administrador no se puede regenerar ni desactivar'` (ahora: se puede). En `public/js/store.js` cambiar la regla de copias antiguas de `!space.is_admin && hasLocalData()` a `!space.is_principal && hasLocalData()` y ajustar sus pruebas de `test/store-space.test.mjs`.

- [ ] **Step 5: Correr todo**

Run: `npm test`
Expected: todas pasan (las 292 de antes, ajustadas, más las nuevas); `test/isolation.test.mjs` sigue en 699 líneas o menos; `src/handlers.mjs` bajo 700.

- [ ] **Step 6: Commit**

```bash
git add src test public/js/store.js
git commit -m "feat: la administración tiene su propio código y Principal pasa a ser un espacio como los demás"
```

---

### Task 2: Renombrar espacios (servidor)

**Files:**
- Modify: `src/spaces.mjs`, `src/handlers.mjs`, `public/js/store.js` (función `renameSpace`)
- Test: `test/spaces.test.mjs` (o `test/manager.test.mjs` si el primero ya pasa de 650 líneas)

**Interfaces:**
- Consumes: `spaceEditable`/existencia, `text(value, label, { max })` de `src/errors.mjs`, `MANAGER_SPACE` y la compuerta de `/api/spaces` de la Tarea 1.
- Produces: `renameSpace(db, id, body): Promise<{ id, name }>` en `src/spaces.mjs`; `PUT /api/spaces/:id` acepta `{ name }` o `{ active }`; `store.renameSpace(id, name): Promise<{ id, name }>` en el cliente.

- [ ] **Step 1: Pruebas que fallan** (en el archivo indicado):
  - `'renombrar: cambia el nombre, lo recorta y la lista lo muestra'` (`PUT { name: '  Familia Pérez  ' }` devuelve `{ id, name: 'Familia Pérez' }`).
  - `'renombrar: Principal se puede renombrar'`.
  - `'renombrar: nombre vacío, solo espacios, de 41 caracteres o que no es texto (123, {}, null) dan 400'` y no cambian nada.
  - `'renombrar: un cuerpo con name y active a la vez, o sin ninguna de las dos, da 400'`.
  - `'renombrar: id inexistente da 404 No encontrado'`.
  - `'renombrar: no cambia el código ni el estado activo del espacio'` (el código anterior sigue entrando).
  - `'renombrar: un espacio de datos y quien no es administración reciben 404'`.
  - `'text() con un nombre que no es cadena da 400'` (hoy `text()` convierte `123` en `"123"`; en `renameSpace` y en `createSpace` el nombre debe ser `typeof === 'string'`).

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces.test.mjs`
Expected: FAIL (el nombre no se acepta).

- [ ] **Step 3: Implementar** `renameSpace` y el reparto del `PUT` en `handle()` (`active` boolean → `setSpaceActive`, `name` → `renameSpace`, ambas o ninguna → `400 'Indica solo name o active'`); `createSpace` también exige texto de verdad. Agregar `export const renameSpace = (id, name) => request('PUT', \`/api/spaces/${encodeURIComponent(id)}\`, { name })` en `store.js`.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add src public/js/store.js test
git commit -m "feat: se puede renombrar un espacio"
```

---

### Task 3: La tarjeta de espacios: sin fila especial y con renombrar

**Files:**
- Modify: `public/js/spaces-card.mjs`, `public/js/view-spaces.js`, `public/js/events.js` (acciones y envío del formulario de renombrar)
- Test: `test/spaces-card.test.mjs`

**Interfaces:**
- Consumes: `store.renameSpace(id, name)` (Tarea 2); la lista `{ id, name, created_at, active }` (sin `is_admin`).
- Produces: `spacesCardHtml({ spaces, shown, esc, canShare, error })` sin la rama del administrador: todas las filas ofrecen `Renombrar` (`data-action="rename-space"`), `Nuevo código` (`regen-space`) y `Desactivar`/`Reactivar` (`toggle-space`). Diálogo de renombrar con el patrón del diálogo de crear (`<dialog id="space-dialog">`, formulario `space-rename-form`, error interno `s-error`). Función exportada de `view-spaces.js`: `submitRename(id, name): Promise<void>` que llama a `store.renameSpace`, cierra el diálogo, avisa y recarga la lista.

- [ ] **Step 1: Pruebas que fallan** en `test/spaces-card.test.mjs`:
  - `'cada fila ofrece renombrar, nuevo código y desactivar, Principal incluido'` (ya no existe la etiqueta "Administrador" ni el caso sin botones; reescribir la prueba `'el espacio administrador no tiene botones...'`).
  - `'el nombre de una fila sale escapado en el botón y en el texto'` (un nombre `<b>x</b>` no sale sin escapar en ningún atributo).
  - `'el diálogo de renombrar muestra el nombre actual escapado'` (si se renderiza desde una función pura nueva `renameDialogHtml({ space, esc })`, probarla aquí).

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/spaces-card.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar** la tarjeta y el diálogo (HTML puro en `spaces-card.mjs`, estado y DOM en `view-spaces.js`), las acciones `rename-space`/`cancel-rename` y el envío `space-rename-form` en `events.js` con `busy` y `guardIn('s-error', ...)` como el formulario de crear. Reutilizar clases existentes (`pay row`, `btn`, `sheet`).

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan; `node --check` limpio en los JS cambiados.

- [ ] **Step 5: Commit**

```bash
git add public test
git commit -m "feat: la tarjeta de espacios ofrece renombrar y trata a todos los espacios igual"
```

---

### Task 4: Pantalla de administración y fuera de los Ajustes normales

**Files:**
- Modify: `public/js/router.js`, `public/js/view-spaces.js`, `public/js/view-settings.js`, `public/js/store.js`, `public/css/app.css` o `public/css/screens.css`, `public/sw.js` (subir `CACHE`), `public/index.html` solo si hace falta (no se espera)
- Test: `test/manager-client.test.mjs` (nuevo), `test/shell.test.mjs` si hace falta

**Interfaces:**
- Consumes: `ctx().state.space.is_manager` (el estado trae `space` de la Tarea 1); `viewSpaces()`, `ensureSpaces()`, `resetSpaces()` de la Tarea 3; `net.needsLogin`.
- Produces: `store.isManager(): boolean` (verdadero si el último estado recibido trae `space.is_manager`); `viewManage()` en `view-spaces.js`: HTML de la pantalla "Administración" = título, `viewSpaces()` (que ahora decide por `isManager()`), y botón `data-action="logout"` ("Cambiar código"); clase `manager` en `<html>` mientras `isManager()` sea verdadero.

- [ ] **Step 1: Pruebas que fallan** en `test/manager-client.test.mjs` (módulo `store.js` con almacenamiento falso y `fetch` sobre `handle()` real, como `test/store-space.test.mjs`):
  - `'syncNow de la administración no pide tasas ni envía cola'`: tras recibir un estado con `space.is_manager`, `syncNow()` no hace ninguna petición a `/api/rate` ni `/api/expenses`, aunque haya algo en cola de antes (Review Focus 4).
  - `'la administración no guarda copia local de viajes, personas ni gastos'`: tras `refresh()` el almacenamiento no contiene datos de ningún espacio.
  - `'entrar como administración desde un celular con datos de Principal pide confirmar si hay cola y la descarta al confirmar'` (regla existente de `trySwitchSpace`/`discardCount`: el id `manager` es distinto del guardado).
  - `'volver de la administración al espacio Principal no conserva nada de la administración'`.
  - Fuente: `'router.js muestra viewManage para la administración en cualquier ruta y oculta barra, selector de viaje y ajustes'` y `'view-settings.js ya no incluye la sección Espacios'` (comprobaciones de texto del código fuente como las de `test/shell.test.mjs`).

- [ ] **Step 2: Correr y ver fallar**

Run: `node --test --disable-warning=ExperimentalWarning test/manager-client.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implementar**:
  - `store.js`: `isManager()`; `syncNow()` sale sin pedir nada (salvo el refresco del estado) cuando es administración; `refresh()` no escribe en `bg_state2` datos de administración (el estado vacío no necesita copia).
  - `router.js` `render()`: si `isManager()` poner la clase `manager` en `<html>`, ocultar `$tripBtn`, poner título "Administración" y mostrar `viewManage()` para cualquier ruta, sin dibujar vistas de datos; si no, quitar la clase.
  - CSS: `.manager .tabbar { display: none; }`.
  - `view-spaces.js`: `isAdmin` pasa a decidir por `isManager()`; `viewManage()`.
  - `view-settings.js`: quitar `${viewSpaces()}` y su import; `router.js`: quitar `ensureSpaces()` de la rama de Ajustes y llamarlo al dibujar `viewManage`.
  - `public/sw.js`: subir `CACHE` a `gastos-viaje-v115`.

- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan, incluida `test/shell.test.mjs`.

- [ ] **Step 5: Comprobar en el navegador** (`npm run dev` con `ADMIN_PASSCODE=prueba-admin` y `APP_PASSCODE=prueba` en `.env`): entrar con `prueba` (Principal con sus datos y sin sección Espacios), cerrar sesión, entrar con `prueba-admin` (solo "Administración", sin pestañas), crear, renombrar, regenerar y desactivar un espacio, entrar con el código nuevo desde otra ventana. Revisar a 390 px. Si el implementador no puede abrir un navegador, lo dice en su informe.

- [ ] **Step 6: Commit**

```bash
git add public test
git commit -m "feat: la administración tiene su propia pantalla y los ajustes normales ya no muestran espacios"
```

---

### Task 5: Documentación

**Files:**
- Modify: `README.md`, `.env.example`, `docs/superpowers/specs/2026-11-19-espacios-por-codigo-design.md` (una nota al principio que apunte al diseño nuevo)

**Interfaces:** ninguna.

- [ ] **Step 1: README**: reescribir la sección "Varios grupos (espacios)":
  - `ADMIN_PASSCODE`: código de administrador, largo y aleatorio, distinto de cualquier código de espacio; sin ella no hay administración.
  - La administración no ve ningún dato de los espacios; para ver uno hay que salir y escribir su código.
  - `APP_PASSCODE`: solo siembra el código de Principal la primera vez que alguien entra con ella; después se puede borrar de Netlify. Con solo `APP_PASSCODE` definida la app sigue pidiendo código.
  - **Cambiar o borrar `APP_PASSCODE` NO revoca el código ya sembrado** (antes sí): el hash queda guardado en la base. Para quitarle el acceso a un código viejo o filtrado hay que regenerar el código de Principal en Administración (todos los celulares deberán escribir el nuevo una vez). Como `APP_PASSCODE` suele ser una clave elegida por una persona (y el código de un espacio se guarda con un hash sin sal, pensado para códigos aleatorios de 12 caracteres), se recomienda regenerar Principal a un código aleatorio en cuanto se compruebe que todo funciona. Escribirlo con estas dos advertencias, sin alarmismo.
  - Paso de producción en orden: respaldo JSON y `turso db shell <db> .dump`; poner `ADMIN_PASSCODE`; desplegar dejando `APP_PASSCODE`; entrar una vez con el código de siempre desde el celular; entonces borrar `APP_PASSCODE`. Si se borró antes de entrar, el administrador regenera el código de Principal.
  - Renombrar, regenerar y desactivar valen para todos los espacios, Principal incluido; el código de un espacio desactivado muestra el motivo.
- [ ] **Step 2: `.env.example`**: agregar `ADMIN_PASSCODE=` con un comentario de una línea y reescribir el de `APP_PASSCODE` (solo semilla).
- [ ] **Step 3: Nota** en el diseño anterior: "Cambiado por `2026-11-19-administrador-separado-design.md`: el administrador ya no es el espacio Principal".
- [ ] **Step 4: Correr todo**

Run: `npm test`
Expected: todas pasan.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example docs
git commit -m "docs: ADMIN_PASSCODE, siembra de Principal y pasos para producción"
```

---

## Self-review

- **Cobertura del spec:** variables y regla de "pide código si hay cualquiera" (T1); identidades y claves (T1); rutas permitidas, estado vacío y 404 (T1); siembra (T1); límite de intentos (T1); Principal normal (T1); renombrar (T2, T3); pantalla de administración y fuera de Ajustes, sin copia local ni tasas (T4); regla de copias antiguas por `is_principal` (T1); documentación y pasos de producción (T5). El mensaje del 403 y que no cuente intentos ya están hechos y pasan por las pruebas de T1 (Review Focus 5).
- **Consistencia de nombres:** `MANAGER_SPACE`, `getPrincipalSpace`, `seedPrincipalCode`, `isInactiveSpaceCode`, `renameSpace` (servidor y `store.renameSpace`), `isManager()`, `viewManage()`, `submitRename`, `rename-space`, `space-rename-form` se definen en la tarea que los produce y las siguientes los usan con esa firma.
- **Desvío del diseño:** la siembra ocurre en la primera entrada y no al arrancar (así no hay migración ni se toca el arranque, y las pruebas existentes que abren la base antes de poner la variable siguen válidas); el diseño ya lo dice.
- **Riesgo conocido de orden:** entre la Tarea 1 y la 4 el cliente no tiene pantalla para la administración (la Tarea 1 cambia el servidor y una línea del cliente). No se despliega nada hasta terminar la Tarea 5.
