# Administrador separado de los datos

Fecha: 2026-11-19. Estado: pendiente de aprobación. Parte de `2026-11-19-espacios-por-codigo-design.md` y lo cambia.

## Intención

Hoy `APP_PASSCODE` es a la vez el código del día a día del dueño (con sus viajes en el espacio "Principal") y la llave de administración de todos los espacios. Se quiere separar los dos papeles y que todo lo que tiene datos sea un espacio igual a los demás:

- Existe un único código de **administrador** (`ADMIN_PASSCODE`). Solo sirve para crear, renombrar, regenerar y desactivar espacios. No abre ningún viaje, persona, gasto ni abono.
- **No existe un código "de la app"**. El dueño usa un espacio como cualquier otro grupo, creado y gestionado por el administrador: tiene su código, se puede renombrar, regenerar o desactivar.
- Para ver otro espacio, la persona escribe el código de ese espacio. Para administrar, el del administrador.

## Qué pasa con producción

Producción todavía no tiene espacios (esta rama no se ha desplegado). Al desplegar, la migración que ya existe crea un único espacio, "Principal", y le asigna **todos** los datos de hoy. Con este diseño:

- Los datos no se mueven ni se copian: siguen siendo las mismas filas.
- Los celulares de hoy entran con el `APP_PASSCODE` de siempre. Para que no tengan que escribir nada nuevo, **la primera vez que alguien entra con `APP_PASSCODE`** el servidor guarda su hash como código de Principal, solo si Principal aún no tiene código. Desde ahí Principal se reconoce como cualquier otro espacio, por su hash. Nunca pisa un código que ya exista.
- Después de esa primera entrada (cualquier celular, o el propio dueño) `APP_PASSCODE` ya no hace falta y se puede borrar de Netlify. Si se deja puesta no hace nada más: no es un código de entrada aparte, solo la semilla de una sola vez.
- Después del despliegue hay exactamente un espacio (Principal). Los demás grupos aparecen cuando el administrador los crea.
- Si por cualquier motivo Principal queda sin código (por ejemplo, se borró `APP_PASSCODE` antes de que nadie entrara con ella), el administrador entra, ve Principal en la lista y le genera un código con "Regenerar".

## Objetivos

- El código de administrador no da acceso a datos de ningún espacio, ni siquiera al de Principal.
- Todos los espacios, Principal incluido, se comportan igual: un código, renombrar, regenerar, desactivar.
- Nada cambia para los celulares ya instalados.
- Que olvidar poner `ADMIN_PASSCODE` nunca deje la app abierta a todo el mundo.
- Renombrar espacios (pedido nuevo).
- Quien usa el código de un espacio desactivado ve el motivo (ya hecho: 403, sin gastar intentos).

## No objetivos

- Varios administradores ni roles.
- Que el administrador pueda "entrar" a un espacio sin su código.
- Cuentas con correo y contraseña.

## Anti-objetivos

- Que el código de administrador, aunque se filtre o se adivine, abra viajes, gastos o personas de alguien.
- Que cambiar `ADMIN_PASSCODE` mueva o pierda datos.
- Que con el despliegue el dueño tenga que reconfigurar sus celulares.
- Que la app quede abierta sin querer.

## Diseño

### Variables de entorno

- `ADMIN_PASSCODE`: código de administrador. Larga y aleatoria. Si no está definida **no hay rutas ni pantalla de administración**.
- `APP_PASSCODE` (la de hoy): solo sirve de semilla de una sola vez del código de Principal (ver "Siembra"). No es un código de entrada permanente.
- **La app pide código si está definida cualquiera de las dos.** Solo si ninguna está definida queda abierta (desarrollo local): todos entran a Principal y no hay administración. Así, olvidar `ADMIN_PASSCODE` en producción no abre nada.
- Si `ADMIN_PASSCODE` coincide con el código de un espacio, gana el administrador. (Una advertencia en el README: usar códigos distintos.)

### Identidades

La autenticación devuelve ahora una de tres cosas:

1. Un espacio de datos (por su código), con `is_manager = false`. `is_principal = true` solo para el espacio histórico `space-admin` (lo usa el cliente para decidir si conserva la copia local de antes de los espacios; ver abajo).
2. La **administración**: `{ id: 'manager', name: 'Administración', is_manager: true, is_principal: false }`. No es una fila de `spaces`, no tiene datos y su id no choca con ningún espacio real (esos son `space-admin` o un UUID). Se reconoce comparando el código con `ADMIN_PASSCODE` (tiempo constante), antes de buscar en los espacios.
3. Nada: 401 (código incorrecto) o 403 (espacio desactivado).

La columna `spaces.is_admin` y el id `space-admin` se conservan por historia, **sin leerse para decidir nada**: Principal ya no tiene reglas propias (se puede regenerar, desactivar y renombrar como cualquiera).

### Qué puede hacer la administración

Solo estas rutas; todas las demás responden `404 'Ruta no encontrada'`: `GET /api/ping`, `GET /api/state` y las de `/api/spaces`.

- `GET /api/state` devuelve un estado sin datos, sin consultar ninguna tabla de datos: `{ today, space: { id: 'manager', name: 'Administración', is_manager: true, is_principal: false }, trips: [], people: [], payment_methods: [], expenses: [], payments: [] }`.
- `GET /api/spaces`: lista con `{ id, name, created_at, active }`, Principal incluido, sin ningún dato de los espacios ni hashes.
- `POST /api/spaces`, `POST /api/spaces/:id/regenerate`, `PUT /api/spaces/:id` con `{ active }` o `{ name }`. Un cuerpo con las dos claves, o con ninguna válida, es 400.
- **Renombrar** (nuevo): `{ name }`, texto de 1 a 40 caracteres sin espacios sobrantes; id inexistente es 404.

Un espacio de datos recibe `404` en `/api/spaces`, como hoy.

### Límite de intentos

Igual que hoy, con una diferencia: acertar con `ADMIN_PASSCODE` reinicia el contador de la red; acertar con el código de un espacio solo descuenta ese intento. Así quien tiene un código de espacio no puede intercalar aciertos para adivinar el de administrador. El código de un espacio desactivado tampoco gasta intentos (ya hecho).

### Cliente

- `state.space.is_manager` decide la vista. La app muestra una sola pantalla, "Administración", con la lista de espacios y sus botones (crear, renombrar, regenerar, desactivar o reactivar), sin barra de pestañas, sin selector de viaje y sin los ajustes de viajes.
- Un botón para salir ("Cambiar código"), que olvida el código y vuelve a la pantalla de acceso.
- La administración no guarda copia de datos en el celular, porque no tiene, y no pide tasas ni envía colas.
- La sección "Espacios" desaparece de los Ajustes de un espacio normal.
- Regla de las copias antiguas: un celular con datos anteriores a los espacios y sin espacio guardado conserva su copia solo si entra al espacio con `is_principal` (hoy lo decide `is_admin`). La administración nunca tiene copia local.

### Siembra del código de Principal (sin migración de base)

No cambia el esquema ni el arranque. Al autenticar, si el código no corresponde a ningún espacio, `APP_PASSCODE` está definida, el código es igual a ella (comparación en tiempo constante) y no se reduce a vacío al normalizarlo, se guarda su hash como `code_hash` de Principal con una sola sentencia que solo actúa si Principal aún no tiene código y ningún otro espacio usa ese hash. Luego se vuelve a buscar el espacio por hash: entra a Principal si está activo y da el 403 de "desactivado" si no. Cuenta como un acierto para el límite de intentos.

## Pruebas

- La administración (`ADMIN_PASSCODE`) recibe 404 en viajes, personas, medios de pago, gastos, abonos, orden, tasas, respaldo, restauración y lugares, con ids reales de otro espacio; su estado está vacío y no consulta datos.
- Un código de espacio recibe 404 en `/api/spaces`; sin `ADMIN_PASSCODE` definida, `/api/spaces` da 404 con cualquier código.
- Con solo `APP_PASSCODE` definida (producción antes de poner `ADMIN_PASSCODE`) la app NO queda abierta: sin código da 401, y el código de Principal entra tras la siembra.
- Sin ninguna de las dos variables: abierta, todos a Principal, sin administración.
- Siembra: la primera entrada con `APP_PASSCODE` deja a Principal con ese hash y entra; entrar otra vez no cambia nada; un Principal que ya tiene código no se pisa (`APP_PASSCODE` deja de entrar); cambiar `APP_PASSCODE` en el entorno después de sembrar no cambia el código de Principal; `APP_PASSCODE` que se reduce a vacío no siembra; un código de otro espacio nunca siembra; con Principal desactivado, la primera entrada siembra y da 403.
- Principal se puede regenerar, desactivar (403 con motivo) y renombrar como cualquier espacio.
- Barrido de todas las rutas con la administración: ninguna respuesta contiene datos de un espacio.
- Límite de intentos: acertar con un código de espacio, intercalado entre fallos, sigue llegando a 429; acertar con `ADMIN_PASSCODE` reinicia la red.
- Renombrar: nombre vacío, de más de 40, no texto, `name` con `active`, id inexistente (404); el nombre sale escapado.
- Claves de la API: ninguna respuesta lleva `is_admin`; `state.space` lleva `is_manager` e `is_principal`; la lista de espacios no lleva ninguna de las dos.
- Cliente: la vista de administración no muestra pestañas ni viajes y no pide tasas; una copia anterior a los espacios se conserva solo si el espacio entrante es `is_principal`.

## Queda para quien construya

- Textos de la pantalla de administración y de la advertencia de código repetido.
- README y `.env.example`: `ADMIN_PASSCODE` nueva (larga y aleatoria, distinta de cualquier código de espacio), y el paso de producción: dejar `APP_PASSCODE` puesta en el primer despliegue y borrarla después.
- Si la vista de administración reutiliza `view-spaces.js` y `spaces-card.mjs` (lo más probable) o conviene un archivo aparte; mantener los archivos bajo 700 líneas.

## Decisiones mías para revisar

- El nombre `ADMIN_PASSCODE` (ya aprobado por el dueño).
- La administración tiene id `manager` y no es una fila de `spaces`.
- `APP_PASSCODE` se conserva solo como semilla de una sola vez, en la primera entrada y no al arrancar (así no hay migración ni se toca el arranque); mientras esté definida (sola) la app pide código.
- Principal se puede regenerar y desactivar: es la consecuencia de que todos los espacios sean iguales.
- `is_admin` y `space-admin` se quedan por historia, sin migración de nombres.
