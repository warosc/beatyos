/**
 * Contraseña temporal que la propietaria asigna a quien olvidó la suya.
 *
 * Dos palabras y cuatro cifras —«CoralBrisa4821»— se dictan sin deletrear y cumplen la
 * política de la API: al menos 12 caracteres (cada palabra tiene 4 o más), mayúscula,
 * minúscula y número. No pretende durar: quien la recibe la cambia en «Perfil y ajustes».
 */
const WORDS = [
  'Agua', 'Arena', 'Brisa', 'Bruma', 'Canela', 'Cedro', 'Cereza', 'Cielo',
  'Clavel', 'Cobre', 'Coral', 'Dalia', 'Faro', 'Flor', 'Fresa', 'Gema',
  'Hoja', 'Isla', 'Jade', 'Lago', 'Lila', 'Lirio', 'Lluvia', 'Luna',
  'Mango', 'Menta', 'Miel', 'Nieve', 'Nube', 'Olivo', 'Palma', 'Perla',
  'Pino', 'Plata', 'Prado', 'Roble', 'Rosa', 'Salvia', 'Sauce', 'Seda',
  'Selva', 'Tierra', 'Trigo', 'Valle', 'Vela', 'Viento', 'Violeta', 'Zafiro',
]; // prettier-ignore

/** Entero aleatorio en `[0, max)` con el generador criptográfico del navegador. */
function secureRandom(max: number): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return value! % max;
}

export function temporaryPassword(random: (max: number) => number = secureRandom): string {
  const word = () => WORDS[random(WORDS.length)];
  const digits = String(random(10_000)).padStart(4, '0');
  return `${word()}${word()}${digits}`;
}
