// Países y monedas que se pueden elegir para el viaje.
// digits: decimales con que se muestra la moneda (COP, CLP, JPY... se muestran sin centavos).
// Todos los montos se guardan en centésimas (2 decimales) sin importar la moneda.
export const CURRENCIES = [
  { code: 'BRL', country: 'Brasil', name: 'Real brasileño', locale: 'pt-BR', digits: 2 },
  { code: 'COP', country: 'Colombia', name: 'Peso colombiano', locale: 'es-CO', digits: 0 },
  { code: 'USD', country: 'Estados Unidos', name: 'Dólar estadounidense', locale: 'en-US', digits: 2 },
  { code: 'EUR', country: 'Europa (euro)', name: 'Euro', locale: 'es-ES', digits: 2 },
  { code: 'ARS', country: 'Argentina', name: 'Peso argentino', locale: 'es-AR', digits: 2 },
  { code: 'CLP', country: 'Chile', name: 'Peso chileno', locale: 'es-CL', digits: 0 },
  { code: 'PEN', country: 'Perú', name: 'Sol peruano', locale: 'es-PE', digits: 2 },
  { code: 'MXN', country: 'México', name: 'Peso mexicano', locale: 'es-MX', digits: 2 },
  { code: 'UYU', country: 'Uruguay', name: 'Peso uruguayo', locale: 'es-UY', digits: 2 },
  { code: 'PYG', country: 'Paraguay', name: 'Guaraní paraguayo', locale: 'es-PY', digits: 0 },
  { code: 'BOB', country: 'Bolivia', name: 'Boliviano', locale: 'es-BO', digits: 2 },
  { code: 'CRC', country: 'Costa Rica', name: 'Colón costarricense', locale: 'es-CR', digits: 2 },
  { code: 'DOP', country: 'República Dominicana', name: 'Peso dominicano', locale: 'es-DO', digits: 2 },
  { code: 'GTQ', country: 'Guatemala', name: 'Quetzal', locale: 'es-GT', digits: 2 },
  { code: 'CAD', country: 'Canadá', name: 'Dólar canadiense', locale: 'en-CA', digits: 2 },
  { code: 'GBP', country: 'Reino Unido', name: 'Libra esterlina', locale: 'en-GB', digits: 2 },
  { code: 'CHF', country: 'Suiza', name: 'Franco suizo', locale: 'de-CH', digits: 2 },
  { code: 'TRY', country: 'Turquía', name: 'Lira turca', locale: 'tr-TR', digits: 2 },
  { code: 'AED', country: 'Emiratos Árabes', name: 'Dírham', locale: 'ar-AE', digits: 2 },
  { code: 'MAD', country: 'Marruecos', name: 'Dírham marroquí', locale: 'fr-MA', digits: 2 },
  { code: 'EGP', country: 'Egipto', name: 'Libra egipcia', locale: 'ar-EG', digits: 2 },
  { code: 'ZAR', country: 'Sudáfrica', name: 'Rand', locale: 'en-ZA', digits: 2 },
  { code: 'INR', country: 'India', name: 'Rupia india', locale: 'en-IN', digits: 2 },
  { code: 'CNY', country: 'China', name: 'Yuan', locale: 'zh-CN', digits: 2 },
  { code: 'JPY', country: 'Japón', name: 'Yen', locale: 'ja-JP', digits: 0 },
  { code: 'KRW', country: 'Corea del Sur', name: 'Won', locale: 'ko-KR', digits: 0 },
  { code: 'THB', country: 'Tailandia', name: 'Baht', locale: 'th-TH', digits: 2 },
  { code: 'AUD', country: 'Australia', name: 'Dólar australiano', locale: 'en-AU', digits: 2 },
  { code: 'NZD', country: 'Nueva Zelanda', name: 'Dólar neozelandés', locale: 'en-NZ', digits: 2 },
];

export const DEFAULT_SETTINGS = { dest: 'BRL', home: 'COP' };

export const currencyByCode = (code) => CURRENCIES.find((c) => c.code === code);
