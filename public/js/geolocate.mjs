// Lectura del GPS del dispositivo. Módulo sin DOM: el navegador y las pruebas lo usan.
//
// Una sola lectura del GPS suele traer un punto impreciso, y con el GPS en frío (o dentro de un edificio) la lectura exacta tarda.
// Por eso se pide a la vez:
//  - una lectura rápida, aunque sea aproximada y de hace unos segundos (red o Wi-Fi), que llega primero;
//  - una escucha del GPS exacto, que va mejorando la lectura.
// Termina en cuanto hay una lectura de ±goodM m; o pasados okAfterMs si ya hay una de ±okM m; o si ya hay una usable (±stallM m)
// y no mejora en stallMs (dentro de un edificio la precisión se estanca y esperar más no sirve); o al llegar a maxMs con la mejor que haya.
// Una lectura aproximada (a kilómetros) nunca corta la espera por estancamiento: el GPS en frío puede tardar y mejora de golpe.
// Si no hubo ninguna rechaza con el error del navegador ({ code: 1 } permiso denegado, 2 sin señal, 3 se acabó el tiempo).
//
// `onFix(lectura)` avisa con cada lectura que mejora a la anterior (para mostrarla ya); `onProgress(precisión en m)` también;
// `signal` cancela la búsqueda (rechaza con { code: 0 }). `geo` es navigator.geolocation (se puede pasar otro para probar).
export function readPosition({ goodM = 25, okM = 50, okAfterMs = 2500, stallM = 150, stallMs = 3000, maxMs = 6000, onProgress, onFix, signal } = {}, geo = globalThis.navigator?.geolocation) {
  return new Promise((resolve, reject) => {
    if (!geo) return reject({ code: 2 });
    if (signal?.aborted) return reject({ code: 0 });
    let best = null;
    let watchId = null;
    let over = false;
    let stallTimer = null;
    const timers = [];
    const stop = () => {
      over = true;
      if (watchId != null) geo.clearWatch(watchId);
      timers.forEach(clearTimeout);
      clearTimeout(stallTimer);
      signal?.removeEventListener('abort', cancel);
    };
    const finish = (err) => {
      if (over) return;
      stop();
      if (best) resolve(best); else reject(err ?? { code: 3 });
    };
    function cancel() {
      if (over) return;
      stop();
      reject({ code: 0 });
    }
    signal?.addEventListener('abort', cancel);
    const got = (pos) => {
      if (over) return;
      const c = pos?.coords;
      if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
      const accuracy = Number.isFinite(c.accuracy) ? c.accuracy : 9999;
      if (!best || accuracy < best.accuracy) {
        best = { lat: c.latitude, lng: c.longitude, accuracy };
        onProgress?.(best.accuracy);
        onFix?.(best);
        // Cada mejora reinicia el reloj de estancamiento.
        clearTimeout(stallTimer);
        if (best.accuracy <= stallM) stallTimer = setTimeout(() => finish(), stallMs);
      }
      if (best.accuracy <= goodM) finish();
    };
    // Solo el permiso denegado corta la espera: otros errores (todavía sin señal) pueden resolverse con la siguiente lectura.
    const failed = (err) => { if (err?.code === 1) finish(err); };
    try {
      geo.getCurrentPosition(got, failed, { enableHighAccuracy: false, timeout: 4000, maximumAge: 30000 });
      watchId = geo.watchPosition(got, failed, { enableHighAccuracy: true, timeout: maxMs + 4000, maximumAge: 0 });
    } catch {
      return finish({ code: 2 });
    }
    if (over) { geo.clearWatch(watchId); return; } // una lectura inmediata ya terminó antes de tener el id de la escucha
    timers.push(setTimeout(() => { if (best && best.accuracy <= okM) finish(); }, okAfterMs));
    timers.push(setTimeout(() => finish(), maxMs));
  });
}

// Zoom para mostrar una lectura: con buena precisión se acerca a la calle; con una lectura muy imprecisa (por ejemplo, aproximada por
// la red, a kilómetros) se aleja para que se vea todo el círculo de error y no parezca que el punto está en un lugar exacto.
export function zoomForAccuracy(accuracyM, { street = 18, min = 12 } = {}) {
  if (!Number.isFinite(accuracyM) || accuracyM <= 150) return street;
  // Cada nivel de zoom duplica la escala: un círculo de radio r cabe cuando 2r ~ 400 m * 2^(street - zoom) aprox.
  const z = street - Math.log2(accuracyM / 150) - 1;
  return Math.max(min, Math.min(street, Math.round(z)));
}
