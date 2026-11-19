# Gastos de viaje

Registro de gastos de viajes con amigos o familia. Por cada viaje eliges el país donde gastas y tu moneda; cada gasto se convierte con la tasa del día de la compra, y al final la app calcula quién le paga a quién.

- **Varios viajes**, cada uno con su país, su moneda de casa y las personas que van (Brasil, Argentina, México, Europa, Japón... y tu moneda). Se cambia de viaje desde el selector de arriba.
- Tarjetas (nombre, últimos 4 dígitos, débito o crédito), transferencias y efectivo, cada uno con su dueño. Si no sabes con qué se pagó, el gasto queda "por definir" y no entra en las cuentas hasta que lo completes.
- Gastos solo tuyos, de otra persona o compartidos en partes iguales. Opcionales: ubicación (GPS o buscando el lugar por nombre) y marca de monto aproximado.
- **Inicio** con el resumen del viaje: total, gasto de hoy, promedio por día, gasto mayor, gasto por día y reparto por medio de pago y por quién pagó.
- **Gastos**: lista por día con totales en las dos monedas, filtros (día, medio, para quién, quién pagó, aproximados, sin ubicación, tasa pendiente) y orden manual dentro de cada día (mantén presionado y arrastra).
- **Mapa** del recorrido con los lugares numerados por su primera visita.
- **Cuentas**: saldo por persona y los pagos que dejan todo en cero.
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

La configuración local está en `.env` (copia `.env.example` si no existe): puerto, archivo de la base, `HOST` y un código de acceso opcional. No pongas ahí `TURSO_*`, porque la app local usaría la base de producción.

Para abrirlo desde el celular en la misma red wifi: pon `HOST=0.0.0.0` en `.env` y entra a `http://IP-DE-TU-PC:3000`. Por ser `http`, el celular no puede instalarla ni usarla sin internet así; eso requiere la versión desplegada (https).

## Primeros pasos en la app

1. Ajustes, Viajes: crea o edita el viaje. Elige el país donde gastas y tu moneda (solo se pueden cambiar mientras el viaje no tenga gastos) y quiénes van.
2. Ajustes, Personas: agrega a las personas del paseo (incluido tú, como una persona más).
3. Ajustes, Medios de pago: agrega tarjetas, transferencias y efectivo, indicando de quién es cada uno.
4. Botón +: registra gastos. Puedes poner el día de ayer o antier.
5. Inicio y Cuentas: el resumen del viaje, el saldo por persona y los pagos que dejan todo en cero.

En Ajustes, lo que afecta solo al viaje activo (mapa, actualizar tasas, exportar CSV) está arriba, bajo "Este viaje"; lo común a todos los viajes (viajes, personas, medios de pago, apariencia, sincronizar, respaldo, restaurar y código de acceso) está abajo, bajo "Global".

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
   - `APP_PASSCODE`: código de acceso. La URL de Netlify es pública, así que ponlo siempre.
   - `FOURSQUARE_API_KEY` (opcional): activa “Buscar más lugares”. Sin ella la app funciona igual solo con OpenStreetMap. Ponla junto con `APP_PASSCODE`: cada consulta gasta cupo de tu cuenta de Foursquare.
4. Abrir la URL en el celular y “Agregar a pantalla de inicio”.

Para llevar los datos que ya tengas en local a Turso: `turso db create gastos-viaje --from-file data/gastos.db`.

### Actualizar una versión ya desplegada

El esquema se actualiza solo: la primera petición después de desplegar corre las migraciones (agregar o borrar columnas, de forma idempotente). Algunas, como borrar columnas que ya se calculan, no tienen vuelta atrás, así que **haz un respaldo antes de desplegar**: desde la app (Ajustes, Respaldo) o con `turso db shell gastos-viaje .dump`. Los celulares con la app abierta deben recargarla una vez para tomar la versión nueva del service worker; cada cambio visible sube el número de caché en `public/sw.js`.

## Cómo está armado

- `public/`: la app (HTML, CSS, JS, service worker, manifest). `public/js/app.js` son las pantallas y `public/js/store.js` la copia local, la cola de gastos sin enviar y las llamadas a la API.
- Módulos sin DOM que usan el navegador y las pruebas: `settlement.mjs` (cuentas), `money.mjs` y `currencies.mjs` (dinero y monedas), `stats.mjs` (resumen del Inicio), `order.mjs` (orden de los gastos), `places.mjs` (recorrido del mapa), `geosearch.mjs` (búsqueda de lugares), `nearby.mjs` (lugares usados y sitios cercanos), `picker.mjs` (lógica del diálogo “Lugar del gasto”), `chart.mjs` (gráfico de la tasa) y `cards.mjs` (aspecto de las tarjetas).
- `src/handlers.mjs`: la API. `src/db.mjs`: SQLite local (`node:sqlite`) o Turso, con migración de bases antiguas. `src/rates.mjs`: tasas. `src/backup.mjs`: respaldo y restauración.
- `server.mjs`: servidor local. `netlify/functions/api.mjs`: la misma API en Netlify.

Todos los montos se guardan como enteros en centésimas. Las tasas vienen de fuentes gratuitas y cada una guarda de cuál salió (ver "Tasas de cambio" más abajo). Si un día no tiene dato se usa el anterior y el gasto queda marcado como “Tasa estimada”. No hay tasa manual.

### Lugar del gasto

En el formulario, “Elegir lugar en el mapa” abre un solo diálogo: arriba el buscador y el botón **Mi ubicación**, en medio el mapa y debajo la lista. Todo fija un punto (tu GPS, un toque en el mapa o un resultado de búsqueda); alrededor de ese punto la lista ofrece **Este punto** (el punto exacto, con campo de nombre), los **lugares que ya usaste** (se copian tal cual, así el mismo sitio queda con las mismas coordenadas) y los **sitios cercanos**. Se elige una fila y se confirma con “Usar este lugar”. Las posiciones de Foursquare son aproximadas (un punto por dirección, que suele caer en la calle): si el lugar está en OpenStreetMap con su edificio dibujado se usa esa posición, y si el pin no coincide se puede **arrastrar** o usar “📌 Ajustar pin”. La posición corregida se guarda con el gasto y vuelve a salir en “Lugares que ya usaste”.

### Servicios externos

Solo se usan desde el navegador o el servidor para lo siguiente, y ninguno recibe tus gastos:

- Tasas de cambio: `cdn.jsdelivr.net` y `currency-api.pages.dev` (principal) y `api.frankfurter.dev` (respaldo).
- Mapa: teselas de Stadia Maps (`tiles.stadiamaps.com`, estilos OSM Bright y Alidade Smooth Dark, datos de OpenStreetMap), sin clave: Stadia identifica el sitio por su dirección. En su panel (Manage Properties, Authentication Configuration) hay que registrar el dominio de Netlify; `localhost` no necesita nada. Si Stadia falla, la app usa teselas de OpenStreetMap. Reciben las zonas del mapa que miras, no tus gastos.
- Búsqueda de lugares: Photon (`photon.komoot.io`) y, si falla, Nominatim (`nominatim.openstreetmap.org`). Reciben el texto que buscas y tu ubicación aproximada o el centro del mapa para poner primero lo cercano.
- Más lugares (opcional; se consulta al usar “Mi ubicación”, al enviar una búsqueda por nombre o al tocar “Buscar más lugares”): Foursquare Places (`places-api.foursquare.com`), consultado desde el servidor con tu clave. Recibe el punto del gasto, nunca tus gastos. Encuentra edificios y negocios que no están en OpenStreetMap.
- Sitios cercanos en el diálogo “Lugar del gasto” (al usar Mi ubicación, tocar el mapa o elegir un resultado): Overpass (`overpass-api.de`) y, si falla, Photon (`photon.komoot.io/reverse`). Reciben el punto elegido para devolver los sitios con nombre cercanos.

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
