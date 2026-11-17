import test from 'node:test';
import assert from 'node:assert/strict';
import { cardPaint, detectNetwork, isHexColor, suggestColor } from '../public/js/cards.mjs';

test('red: se deduce de los primeros dígitos', () => {
  assert.equal(detectNetwork('4'), 'visa');
  assert.equal(detectNetwork('4111 1111'), 'visa');
  assert.equal(detectNetwork('51'), 'mastercard');
  assert.equal(detectNetwork('5412'), 'mastercard');
  assert.equal(detectNetwork('2221'), 'mastercard');
  assert.equal(detectNetwork('2720'), 'mastercard');
  assert.equal(detectNetwork('37'), 'amex');
  assert.equal(detectNetwork('3782'), 'amex');
  assert.equal(detectNetwork('6011'), 'discover');
  assert.equal(detectNetwork('36'), 'diners');
});

test('red: Elo y Hipercard tienen rangos propios y ganan sobre Visa y Discover', () => {
  assert.equal(detectNetwork('4011'), 'elo');
  assert.equal(detectNetwork('5067'), 'elo');
  assert.equal(detectNetwork('650'), 'elo');
  assert.equal(detectNetwork('606282'), 'hipercard');
  assert.equal(detectNetwork('3841'), 'hipercard');
  // Con un solo dígito todavía adivina Visa; al llegar al cuarto dígito corrige a Elo.
  assert.equal(detectNetwork('40'), 'visa');
});

test('red: sin dígitos o con un prefijo desconocido no inventa nada', () => {
  assert.equal(detectNetwork(''), null);
  assert.equal(detectNetwork(null), null);
  assert.equal(detectNetwork('abc'), null);
  assert.equal(detectNetwork('9'), null);
  assert.equal(detectNetwork('5'), null); // todavía no alcanza para decir Mastercard
});

test('color: solo acepta #rrggbb', () => {
  assert.equal(isHexColor('#7c3aed'), true);
  assert.equal(isHexColor('#7C3AED'), true);
  for (const bad of ['', 'rojo', '#fff', '#12345', '#1234567', '7c3aed', null, undefined, 12]) {
    assert.equal(isHexColor(bad), false, String(bad));
  }
});

test('color: el texto se adapta (blanco sobre oscuro, oscuro sobre claro) y lo inválido cae al gris', () => {
  assert.equal(cardPaint('#1d4ed8').fg, '#ffffff');
  assert.equal(cardPaint('#f5d547').fg, '#16181d');
  assert.equal(cardPaint('#1d4ed8').c1, '#1d4ed8');
  assert.notEqual(cardPaint('#1d4ed8').c2, '#1d4ed8'); // el degradado termina más oscuro
  assert.equal(cardPaint('nada').c1, '#3b4252');
});

test('color sugerido por el nombre: ignora tildes y mayúsculas; Nu y C6 solo como palabra', () => {
  assert.equal(suggestColor('bancolombia'), '#a8841a');
  assert.equal(suggestColor('Itau'), '#c2410c');
  assert.equal(suggestColor('Davivienda Amex'), '#dc2626');
  assert.equal(suggestColor('Nu'), '#7c3aed');
  assert.equal(suggestColor('Mi Nu'), '#7c3aed');
  assert.equal(suggestColor('Nueva cuenta'), null);
  assert.equal(suggestColor('Tarjeta sin datos'), null);
  assert.equal(suggestColor(''), null);
  assert.equal(suggestColor(undefined), null);
});
