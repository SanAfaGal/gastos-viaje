// Errores de la API: un HttpError se convierte en la respuesta { status, body: { error } }.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export function text(value, label, { max = 80, required = true } = {}) {
  const s = String(value ?? '').trim();
  if (required && !s) fail(400, `${label} es obligatorio`);
  if (s.length > max) fail(400, `${label} es muy largo`);
  return s;
}
