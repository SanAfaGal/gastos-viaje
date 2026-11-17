# Gastos de viaje

Registro de gastos de un viaje con amigos o familia. Eliges el país donde gastas y tu moneda; cada gasto se convierte con la tasa del día de la compra, y al final la app calcula quién le paga a quién.

- País y moneda a elegir (Brasil, Argentina, México, Europa, Japón... y tu moneda de casa), en Ajustes.
- Tarjetas (nombre, últimos 4 dígitos, débito o crédito), transferencias y efectivo, cada uno con su dueño.
- Gastos solo tuyos, de otra persona o compartidos en partes iguales.
- Funciona en el celular como app instalable y guarda gastos sin internet; los envía al volver la conexión.
- Sin framework: JavaScript normal en el navegador y Node en el servidor. Única dependencia: `@libsql/client` (solo para la versión en línea).

## Usar en tu computador

Requiere Node 22.9 o más nuevo (SQLite viene incluido).

```
npm run dev
```

Abre http://localhost:3000. Los datos quedan en `data/gastos.db`.

La configuración local está en `.env` (copia `.env.example` si no existe): puerto, archivo de la base, `HOST` y un código de acceso opcional. No pongas ahí `TURSO_*`, porque la app local usaría la base de producción.

Para abrirlo desde el celular en la misma red wifi: pon `HOST=0.0.0.0` en `.env` y entra a `http://IP-DE-TU-PC:3000`. Por ser `http`, el celular no puede instalarla ni usarla sin internet así; eso requiere la versión desplegada (https).

## Primeros pasos en la app

1. Ajustes, Viaje: elige el país donde gastas y tu moneda. Solo se puede cambiar mientras no haya gastos registrados.
2. Ajustes: agrega a las personas del paseo (incluido tú, como una persona más).
3. Ajustes: agrega tarjetas, transferencias y efectivo, indicando de quién es cada uno.
4. Botón +: registra gastos. Puedes poner el día de ayer o antier.
5. Cuentas: saldo por persona y los pagos que dejan todo en cero.

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

## Cómo está armado

- `public/`: la app (HTML, CSS, JS, service worker, manifest).
- `public/js/settlement.mjs`, `money.mjs`, `currencies.mjs`: cuentas, dinero y lista de monedas; los usan el servidor y el navegador.
- `src/handlers.mjs`: la API. `src/db.mjs`: SQLite local (`node:sqlite`) o Turso, con migración de bases antiguas. `src/rates.mjs`: tasas.
- `server.mjs`: servidor local. `netlify/functions/api.mjs`: la misma API en Netlify.

Todos los montos se guardan como enteros en centésimas. Tasas: `@fawazahmed0/currency-api` (gratis, sin llave, un valor por día). Si un día no tiene dato se usa el anterior y el gasto queda marcado como “Tasa estimada”. También puedes poner la tasa a mano en cada gasto.

## Pruebas

```
npm test
```
