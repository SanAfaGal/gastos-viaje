// Entorno limpio para las pruebas. Se carga antes de cada archivo de prueba (`node --import`, ver "test" en package.json).
//
// Netlify define estas variables al construir (el comando de construcción es `npm test`): si llegaran a las pruebas, la
// app pediría código (ADMIN_PASSCODE o APP_PASSCODE) o escribiría en la base de producción (TURSO_*), y casi todo
// respondería 401. Cada prueba que necesita una variable la pone ella misma y la restaura al terminar.
for (const name of ['ADMIN_PASSCODE', 'APP_PASSCODE', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'DB_FILE']) {
  delete process.env[name];
}
