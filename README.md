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
- Tema a gusto: modo automático, claro u oscuro y cuatro colores.
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
4. Abrir la URL en el celular y “Agregar a pantalla de inicio”.

Para llevar los datos que ya tengas en local a Turso: `turso db create gastos-viaje --from-file data/gastos.db`.

### Actualizar una versión ya desplegada

El esquema se actualiza solo: la primera petición después de desplegar corre las migraciones (agregar o borrar columnas, de forma idempotente). Algunas, como borrar columnas que ya se calculan, no tienen vuelta atrás, así que **haz un respaldo antes de desplegar**: desde la app (Ajustes, Respaldo) o con `turso db shell gastos-viaje .dump`. Los celulares con la app abierta deben recargarla una vez para tomar la versión nueva del service worker; cada cambio visible sube el número de caché en `public/sw.js`.

## Cómo está armado

- `public/`: la app (HTML, CSS, JS, service worker, manifest). `public/js/app.js` son las pantallas y `public/js/store.js` la copia local, la cola de gastos sin enviar y las llamadas a la API.
- Módulos sin DOM que usan el navegador y las pruebas: `settlement.mjs` (cuentas), `money.mjs` y `currencies.mjs` (dinero y monedas), `stats.mjs` (resumen del Inicio), `order.mjs` (orden de los gastos), `places.mjs` (recorrido del mapa), `geosearch.mjs` (búsqueda de lugares), `chart.mjs` (gráfico de la tasa) y `cards.mjs` (aspecto de las tarjetas).
- `src/handlers.mjs`: la API. `src/db.mjs`: SQLite local (`node:sqlite`) o Turso, con migración de bases antiguas. `src/rates.mjs`: tasas. `src/backup.mjs`: respaldo y restauración.
- `server.mjs`: servidor local. `netlify/functions/api.mjs`: la misma API en Netlify.

Todos los montos se guardan como enteros en centésimas. Tasas: `@fawazahmed0/currency-api` (gratis, sin llave, un valor por día) con Frankfurter de respaldo. Si un día no tiene dato se usa el anterior y el gasto queda marcado como “Tasa estimada”. No hay tasa manual.

### Servicios externos

Solo se usan desde el navegador o el servidor para lo siguiente, y ninguno recibe tus gastos:

- Tasas de cambio: `cdn.jsdelivr.net` y `currency-api.pages.dev` (principal) y `api.frankfurter.dev` (respaldo).
- Mapa: teselas de OpenStreetMap.
- Búsqueda de lugares: Photon (`photon.komoot.io`) y, si falla, Nominatim (`nominatim.openstreetmap.org`). Reciben el texto que buscas y tu ubicación aproximada o el centro del mapa para poner primero lo cercano.

### Decisiones de diseño

- **La tasa es parte del gasto.** Cada gasto guarda la tasa que se usó (`rate`) y el día al que pertenece (`rate_date`), como un recibo. No se consulta en vivo: la tasa de hoy no es definitiva, la fuente gratuita puede variar y la app tiene que mostrar lo mismo sin internet. La tabla `rates` es solo un caché de días cerrados.
- **Lo calculable no se guarda.** El monto en tu moneda y "tasa estimada" se calculan al leer (`getState`); no son columnas.
- **Los días cerrados se corrigen solos.** Si un gasto de un día que ya pasó tiene una tasa distinta de la guardada para ese día, se cambia por la del día cerrado (sin internet no se toca). El botón "Actualizar tasas" hace lo mismo a pedido, mostrando antes cuánto cambia.
- **Respaldo y restauración.** El respaldo JSON es una copia cruda de las tablas. Restaurar solo agrega lo que falta (por id), valida todo antes de escribir y lo hace en una sola transacción: nunca borra ni pisa lo existente.

## Pruebas

```
npm test
```

Cubren la API (incluidas las migraciones de bases antiguas), las tasas, el respaldo y la restauración, las cuentas y los módulos de la interfaz que no dependen del DOM.
