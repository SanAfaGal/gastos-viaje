# Gastos de viaje

Registro de gastos de viajes con amigos o familia. Por cada viaje eliges el país donde gastas y tu moneda; cada gasto se convierte con la tasa del día de la compra, y al final la app calcula quién le paga a quién.

- **Varios viajes**, cada uno con su país, su moneda de casa y las personas que van (Brasil, Argentina, México, Europa, Japón... y tu moneda). Se cambia de viaje desde el selector de arriba.
- Tarjetas (nombre, últimos 4 dígitos, débito o crédito), transferencias y efectivo, cada uno con su dueño. Si no sabes con qué se pagó, el gasto queda "por definir" y no entra en las cuentas hasta que lo completes.
- Gastos solo tuyos, de otra persona o compartidos en partes iguales. Opcionales: ubicación (GPS o buscando el lugar por nombre) y marca de monto aproximado.
- **Inicio** con el resumen del viaje: total, gasto de hoy, promedio por día, gasto mayor, gasto por día y reparto por medio de pago y por quién pagó.
- **Gastos**: lista por día con totales en las dos monedas, filtros (día, medio, para quién, quién pagó, aproximados, sin ubicación, tasa pendiente) y orden manual dentro de cada día (mantén presionado y arrastra).
- **Mapa** del recorrido con los lugares numerados por su primera visita.
- **Cuentas**: lo que falta por saldar entre cada par de personas, con el avance de lo ya abonado, saldo por persona y gasto por medio de pago. **Abonos**: se registran en cualquier moneda del viaje (con la tasa del día) y el diálogo muestra cómo queda la cuenta antes de guardar.
- Al borrar un gasto aparece **Deshacer**.
- Exportar a CSV, **respaldo** completo en JSON y **restaurar** (solo agrega lo que falte).
- Tema a gusto: modo automático, claro u oscuro (la app es siempre verde).
- Funciona en el celular como app instalable y guarda gastos sin internet; los envía al volver la conexión.
- Sin framework: JavaScript normal en el navegador y Node en el servidor. Única dependencia: `@libsql/client` (solo para la versión en línea). El mapa usa Leaflet, que va incluido en `public/vendor/`.

## Usar en tu computador

Requiere Node 22.9 o más nuevo (SQLite viene incluido).

```
npm run dev
```

Abre http://localhost:3000. Los datos quedan en `data/gastos.db`.

La configuración local está en `.env` (copia `.env.example` si no existe): puerto, archivo de la base, `HOST` y los códigos de acceso (opcionales; ver "Varios grupos (espacios)"). No pongas ahí `TURSO_*`, porque la app local usaría la base de producción.

Para abrirlo desde el celular en la misma red wifi: pon `HOST=0.0.0.0` en `.env` y entra a `http://IP-DE-TU-PC:3000`. Por ser `http`, el celular no puede instalarla ni usarla sin internet así; eso requiere la versión desplegada (https).

## Primeros pasos en la app

1. Ajustes, Viajes: crea o edita el viaje. Elige el país donde gastas y tu moneda (solo se pueden cambiar mientras el viaje no tenga gastos) y quiénes van.
2. Ajustes, Personas: agrega a las personas del paseo (incluido tú, como una persona más).
3. Ajustes, Medios de pago: agrega tarjetas, transferencias y efectivo, indicando de quién es cada uno.
4. Botón +: registra gastos. Puedes poner el día de ayer o antier.
5. Inicio y Cuentas: el resumen del viaje, el saldo por persona y los pagos que dejan todo en cero.

En Ajustes, lo que afecta solo al viaje activo (mapa, actualizar tasas, exportar CSV) está arriba, bajo "Este viaje"; lo común a todos los viajes (viajes, personas, medios de pago, apariencia, sincronizar, respaldo, restaurar y código de acceso) está abajo, bajo "Global".

## Varios grupos (espacios)

Cada grupo (una familia, unos amigos) es un espacio con su propio código y sus propios viajes, personas, medios de pago, abonos y gastos; nadie ve los datos de otro espacio. El espacio del dueño se llama **Principal** y es uno más: se usa con su código, igual que los demás. Aparte hay un **administrador**, que solo gestiona los espacios y no ve ningún dato.

- **`ADMIN_PASSCODE`** es el código del administrador. Ponlo **largo y aleatorio** (por ejemplo `openssl rand -base64 24`), distinto de `APP_PASSCODE` y de cualquier código de espacio: alguien podría intentar adivinarlo (a ritmo limitado: 10 intentos por red cada 15 minutos). Sin esta variable no hay administración: la pantalla de Administración y las rutas `/api/spaces` no existen. Si coincide con `APP_PASSCODE`, gana el administrador y ese código ya no abre Principal hasta que el administrador le regenere el código. Si pones `ADMIN_PASSCODE` igual a un código que los celulares ya usan, esos celulares vuelven a pedir el código y sus gastos sin enviar se quedan en el celular hasta que escriban el código de su espacio.
- Al entrar con `ADMIN_PASSCODE` la app muestra solo la pantalla de Administración. Ahí se puede crear, renombrar, regenerar el código y desactivar o reactivar cualquier espacio, Principal incluido. No muestra datos: para ver un espacio hay que tocar "Cambiar código" y escribir el código de ese espacio.
- El código de cada espacio se muestra una sola vez, al crearlo o regenerarlo; el servidor guarda solo su hash. Al compararlo se ignoran mayúsculas, guiones, espacios y signos.
- Regenerar un código hace que el anterior deje de funcionar de inmediato. Un celular con un código que dejó de servir vuelve a la pantalla de acceso, y sus gastos sin enviar se conservan hasta que se vuelva a entrar al mismo espacio.
- Desactivar un espacio impide que entre pero conserva sus datos, y se puede reactivar. Quien escribe el código de un espacio desactivado ve "Este espacio está desactivado. Habla con quien te dio el código." (y eso no gasta intentos).
- **`APP_PASSCODE`** ya no es una clave permanente: solo **siembra** el código de Principal. La primera vez que alguien entra con ella, su hash queda guardado como código de Principal (si Principal aún no tenía uno); desde entonces ese código se reconoce como el de cualquier espacio y la variable se puede borrar de Netlify. Si solo `APP_PASSCODE` está definida (sin `ADMIN_PASSCODE`) la app sigue pidiendo código: nunca queda abierta.
- **Cambiar o borrar `APP_PASSCODE` no revoca el código ya sembrado**: su hash queda guardado en la base. Para quitarle el acceso a un código viejo o filtrado hay que regenerar el código de Principal en Administración (todos los celulares tendrán que escribir el nuevo una vez). Además, `APP_PASSCODE` suele ser una clave que escribió una persona, y el código de un espacio se guarda con un hash sin sal, pensado para códigos aleatorios de 12 caracteres. Por eso conviene regenerar Principal a un código aleatorio en cuanto compruebes que todo funciona.
- Restaurar un respaldo JSON en otro espacio (con otro código) copia las filas con ids nuevos, sin tocar las que ya tiene ese espacio.

### Pasar a producción desde la versión de un solo código

En este orden:

1. Haz un respaldo JSON (Ajustes, Respaldo) y una copia completa en Turso, que incluye todos los espacios (el respaldo JSON trae solo el espacio de quien lo descarga): `turso db shell gastos-viaje .dump > respaldo-antes-del-administrador.sql`.
2. En Netlify pon `ADMIN_PASSCODE`.
3. Despliega dejando `APP_PASSCODE` como está.
4. Entra una vez con el código de siempre desde el celular del dueño: eso siembra el código de Principal.
5. Opcional: borra `APP_PASSCODE` de Netlify. **No lo borres antes del paso 4**: si nadie ha entrado todavía, el dueño se queda sin código (el administrador lo arregla regenerando el código de Principal y dándoselo).
6. Entra con `ADMIN_PASSCODE` y comprueba que Principal aparece en la lista.

### Desarrollo local

Sin ninguna de las dos variables la app queda abierta (todos entran a Principal) y no hay administración. Para probar la administración en local pon en `.env` un `ADMIN_PASSCODE` y un `APP_PASSCODE` distintos.

## Desplegar en Netlify (con Turso)

Netlify no guarda archivos, por eso en línea la base es Turso (SQLite en la nube, plan gratis).

1. Crear la base en Turso:
   ```
   turso auth login
   turso db create gastos-viaje
   turso db show gastos-viaje --url        # TURSO_DATABASE_URL
   turso db tokens create gastos-viaje     # TURSO_AUTH_TOKEN
   ```
2. Subir el proyecto a GitHub y conectarlo en Netlify (o `npx netlify-cli deploy --prod`).
   No hay comando de build; Netlify publica `public/` y la función `netlify/functions/api.mjs`.
3. En Netlify, Site configuration, Environment variables:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `ADMIN_PASSCODE`: código del administrador (largo y aleatorio). La URL de Netlify es pública, así que ponlo siempre. Sin él no hay administración de espacios.
   - `APP_PASSCODE`: solo si vienes de la versión de un solo código: siembra el código de Principal la primera vez que alguien entra con él y después se puede borrar (ver "Pasar a producción" más arriba).
4. Abrir la URL en el celular y “Agregar a pantalla de inicio”.

Para llevar los datos que ya tengas en local a Turso: `turso db create gastos-viaje --from-file data/gastos.db`.

### Actualizar una versión ya desplegada

El esquema se actualiza solo: la primera petición después de desplegar corre las migraciones (agregar o borrar columnas, de forma idempotente). Algunas, como borrar columnas que ya se calculan, no tienen vuelta atrás, así que **haz un respaldo antes de desplegar**: desde la app (Ajustes, Respaldo) o con `turso db shell gastos-viaje .dump`. Los celulares con la app abierta deben recargarla una vez para tomar la versión nueva del service worker; cada cambio visible sube el número de caché en `public/sw.js`.

## Cómo está armado

- `public/`: la app (HTML, CSS, JS, service worker, manifest). Los estilos están en `css/app.css` (base, formularios, menús) y `css/screens.css` (mapas, selector de lugar, medios de pago, inicio). Ningún archivo pasa de 700 líneas (lo comprueba `test/shell.test.mjs`).
- `public/js/store.js`: la copia local, la cola de gastos sin enviar y las llamadas a la API.
- Pantallas y diálogos (módulos con DOM, uno por tema, sin herramienta de empaquetado):
  - `app.js`: arranque; llama a los `init…` de cada módulo y dibuja la primera pantalla.
  - `ui.js` (avisos, ayuda, candado de acciones), `shared.js` (contexto del viaje, estado y fila de cada gasto), `router.js` (rutas, `render`, cambio de viaje, sincronización) y `events.js` (clics por acción, escritura y envío de formularios).
  - `view-home.js` (inicio y gráfico de la tasa), `view-list.js` (gastos, filtros y reordenar arrastrando), `view-form.js` (formulario de gasto), `view-accounts.js` (cuentas y abonos), `view-settings.js` (ajustes), `view-map.js` (mapa del viaje) y `place-picker.js` (diálogo "Lugar del gasto").
  - Un módulo nuevo debe agregarse a la lista `SHELL` de `sw.js` (si no, falla `test/shell.test.mjs`) y, si se carga al abrir, a la precarga de `index.html`.
  - El estado que comparten varios módulos (`draft`, `payOpen`…) vive en el módulo que lo declara; quien lo cambia desde otro módulo usa su función `set…`.
- Módulos sin DOM que usan el navegador y las pruebas: `settlement.mjs` (cuentas) y `accounts.mjs` (deuda entre dos personas, avance y efecto de un abono), `money.mjs` y `currencies.mjs` (dinero y monedas), `stats.mjs` (resumen del Inicio), `order.mjs` (orden de los gastos), `places.mjs` (recorrido del mapa), `geosearch.mjs` (búsqueda de lugares), `nearby.mjs` (lugares usados y sitios cercanos), `picker.mjs` (lógica del diálogo “Lugar del gasto”), `chart.mjs` (gráfico de la tasa) y `cards.mjs` (aspecto de las tarjetas).
- `src/handlers.mjs`: la API. `src/db.mjs`: SQLite local (`node:sqlite`) o Turso, con migración de bases antiguas. `src/rates.mjs`: tasas. `src/backup.mjs`: respaldo y restauración.
- `server.mjs`: servidor local. `netlify/functions/api.mjs`: la misma API en Netlify.

Todos los montos se guardan como enteros en centésimas. Las tasas vienen de fuentes gratuitas y cada una guarda de cuál salió (ver "Tasas de cambio" más abajo). Si un día no tiene dato se usa el anterior y el gasto queda marcado como “Tasa estimada”. No hay tasa manual.

### Lugar del gasto

En el formulario, “Elegir lugar” abre un solo diálogo con dos botones en una fila: **1)** “Abrir Google Maps” abre Google Maps (en otra pestaña o en la app de Mapas) centrado donde estás mirando; ahí buscas el lugar y copias el enlace, las coordenadas o el Plus Code; **2)** vuelves y tocas “Pegar”, que lee el portapapeles (si el navegador no lo deja, pide pegarlo a mano). También se puede tocar el mapa. La app no busca lugares por nombre: el punto lo da Google Maps, que es lo más preciso.

Qué se acepta al pegar:

- **Enlace** de Google Maps, corto (`maps.app.goo.gl/…`) o largo. El servidor sigue la redirección del enlace corto (solo hacia dominios de Google) y saca las coordenadas y el nombre.
- **Coordenadas** en decimales (`6.1732, -75.6298`) o en grados (`6°10′23″N 75°37′47″W`).
- **Plus Code**: completo (`67R659FC+73`) o corto con la ciudad (`59FC+73 Itagüí, Antioquia`; la ciudad se ubica con Photon para completar el código). Un código corto sin ciudad se rechaza.

Todo lugar lleva nombre: el del enlace si lo trae; si no, la dirección del punto (Photon), que se puede cambiar. El botón **Visitados** abre la lista de todos los lugares con ubicación de este viaje, con un buscador (sin acentos ni mayúsculas), del más reciente al más antiguo: elegir uno es un toque y no hace falta volver a Google Maps. Además, debajo del mapa salen los **lugares que ya usaste** cerca del punto, que se copian tal cual. Si el punto quedó corrido, se toca el mapa donde es. Al abrir el diálogo el mapa se centra donde estás (GPS, con un punto azul y su precisión) y el botón de la mira lo vuelve a centrar; el GPS solo orienta: no elige el lugar.

### Servicios externos

Solo se usan desde el navegador o el servidor para lo siguiente, y ninguno recibe tus gastos:

- Tasas de cambio: `cdn.jsdelivr.net` y `currency-api.pages.dev` (principal) y `api.frankfurter.dev` (respaldo).
- Mapa: teselas de Stadia Maps (`tiles.stadiamaps.com`, estilos OSM Bright y Alidade Smooth Dark, datos de OpenStreetMap), sin clave: Stadia identifica el sitio por su dirección. En su panel (Manage Properties, Authentication Configuration) hay que registrar el dominio de Netlify; `localhost` no necesita nada. Si Stadia falla, la app usa teselas de OpenStreetMap. Reciben las zonas del mapa que miras, no tus gastos.
- Nombre de un punto y ciudad de un Plus Code corto: Photon (`photon.komoot.io`) y, si falla, Nominatim (`nominatim.openstreetmap.org`). Reciben el punto o el texto de la ciudad, no tus gastos.
- Enlaces cortos de Google Maps: el servidor abre el enlace (`maps.app.goo.gl`, `google.com`) para leer sus coordenadas. No es una API de pago ni usa clave.

### Tasas de cambio: fuentes y límites

- **Fuente principal:** `@fawazahmed0/currency-api` (gratis, sin llave, un valor por día), pedida a `cdn.jsdelivr.net` y, si falla, a `currency-api.pages.dev` (es el mismo dato). **Respaldo:** Frankfurter (`api.frankfurter.dev`), que se usa si la principal falla o aún no publicó el día. Se queda con la primera que trae exactamente el día pedido; si ninguna lo trae, con la más reciente.
- **Trazabilidad:** cada tasa guardada lleva su fuente (`rates.source`, `expenses.rate_source`: `fawazahmed0` o `frankfurter`) y cuándo se consultó (`rates.fetched_at`). La pantalla del gasto muestra la fuente, el CSV exporta la fecha y la fuente de la tasa, y el respaldo JSON las conserva. Las tasas guardadas antes de que existiera este registro quedan con la fuente vacía ("No registrada"): no se adivina.
- **Un valor por día, con desfase:** la fuente fecha cada valor con el cierre del día anterior, o eso indican las comparaciones. Al contrastar 6 días de noviembre de 2026 con el histórico de Google (BRL→COP), la tasa de la app del día N coincidió con el cierre de Google del día hábil anterior con una diferencia media del 0,08 %; comparando la misma fecha, hasta un 2 %. Por eso puede no coincidir con Google día por día. Es una observación hecha a mano con pocos datos, no una garantía.
- **Fines de semana y feriados:** la fuente trae valores también esos días (aproximados), no solo de días hábiles.
- **La tasa de hoy es provisional:** se pregunta cada vez y no se guarda; solo los días cerrados quedan en caché.
- **No es la tasa de tu banco:** el banco o la tarjeta aplican su propio margen, así que ninguna fuente de mercado va a coincidir con lo que realmente te cobraron.
- **Sin mezclar a escondidas:** si una fuente falla y entra la otra, queda anotado en cada gasto. Google no ofrece una API gratuita oficial de tasas (la Finance API se cerró en 2012; `GOOGLEFINANCE` solo funciona dentro de Google Sheets), por eso no se usa.

### Decisiones de diseño

- **La tasa es parte del gasto.** Cada gasto guarda la tasa que se usó (`rate`) y el día al que pertenece (`rate_date`) y la fuente de la que salió (`rate_source`), como un recibo. No se consulta en vivo: la tasa de hoy no es definitiva, la fuente gratuita puede variar y la app tiene que mostrar lo mismo sin internet. La tabla `rates` es solo un caché de días cerrados.
- **Lo calculable no se guarda.** El monto en tu moneda y "tasa estimada" se calculan al leer (`getState`); no son columnas.
- **Los días cerrados se corrigen solos.** Si un gasto de un día que ya pasó tiene una tasa distinta de la guardada para ese día, se cambia por la del día cerrado (sin internet no se toca). El botón "Actualizar tasas" hace lo mismo a pedido, mostrando antes cuánto cambia.
- **Respaldo y restauración.** El respaldo JSON es una copia cruda de las tablas. Restaurar solo agrega lo que falta (por id), valida todo antes de escribir y lo hace en una sola transacción: nunca borra ni pisa lo existente.

## Pruebas

```
npm test
```

Cubren la API (incluidas las migraciones de bases antiguas), las tasas, el respaldo y la restauración, las cuentas y los módulos de la interfaz que no dependen del DOM.
