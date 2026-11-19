// Arranque de la app: conecta los módulos y dibuja la primera pantalla.
import { initSelects } from './select.mjs';
import { applyUpdate, initRouter, render, sync } from './router.js';
import { initUi } from './ui.js';
import { initPicker } from './place-picker.js';
import { initEvents } from './events.js';
import { initList } from './view-list.js';
import { initHome } from './view-home.js';
import { initForm } from './view-form.js';

initUi();
initPicker();
initRouter();
initEvents();
initList();
initHome();
initForm();

if ('serviceWorker' in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller); // la primera instalación no recarga; una actualización sí
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) applyUpdate(); });
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // El navegador solo busca un service worker nuevo al abrir la app; también se busca al volver a ella y cada 30 minutos.
    const check = () => reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 30 * 60 * 1000);
  }).catch(() => {});
}
initSelects(); // menús desplegables con el estilo de la app
render(); // primero lo guardado en el teléfono; si el servidor trae algo distinto, refresh() avisa y se redibuja
sync();
