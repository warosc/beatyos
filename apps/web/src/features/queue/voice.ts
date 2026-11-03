/**
 * Elección de la voz de los llamados en la pantalla de la sala (ADR-0026).
 *
 * La voz es la del navegador del aparato que mueve la TV: gratis y sin servidores, pero cada
 * aparato trae las suyas. Esto ordena las que haya para que, sin tocar nada, suene la más
 * natural y femenina posible:
 *
 * - Las voces neuronales primero: en Microsoft Edge, «… Online (Natural)» —Marta de
 *   Guatemala, Dalia de México—; las de Google en Chrome; las «mejoradas» de Apple.
 * - Acento cercano: Guatemala, México y el resto de Latinoamérica antes que España.
 * - Femenina: por su nombre. Las masculinas conocidas van al final.
 *
 * El navegador no dice el género de una voz, así que se deduce del nombre; por eso la
 * pantalla deja además escoger y probar a mano.
 */

/** Lo que el navegador cuenta de una voz (`SpeechSynthesisVoice`). */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly localService?: boolean;
}

const FEMALE = new Set([
  'marta',
  'dalia',
  'elvira',
  'paloma',
  'larissa',
  'paulina',
  'monica',
  'sabina',
  'helena',
  'laura',
  'lucia',
  'elena',
  'camila',
  'carla',
  'salome',
  'ximena',
  'beatriz',
  'catalina',
  'renata',
  'valentina',
  'isabel',
  'esperanza',
  'abril',
  'nuria',
  'irene',
  'vera',
  'sofia',
  'andrea',
  'francisca',
  'triana',
  'estrella',
  'ines',
  'candela',
  'karla',
  'maria',
  'carlota',
  'tania',
  'teresa',
  'paola',
  'emilia',
  'luciana',
  'martina',
  'gabriela',
  'marina',
  'manuela',
  'soledad',
  'elsa',
  'yolanda',
  'belkys',
  'female',
  'mujer',
  'femenina',
]);

const MALE = new Set([
  'raul',
  'pablo',
  'jorge',
  'andres',
  'juan',
  'diego',
  'alvaro',
  'carlos',
  'gerardo',
  'jose',
  'luis',
  'lorenzo',
  'alonso',
  'arnau',
  'dario',
  'elias',
  'emilio',
  'federico',
  'gonzalo',
  'javier',
  'liberto',
  'mateo',
  'pedro',
  'ricardo',
  'rodrigo',
  'sergio',
  'tomas',
  'yago',
  'cristian',
  'santiago',
  'victor',
  'tadeo',
  'mario',
  'enrique',
  'marcelo',
  'alejandro',
  'david',
  'jaime',
  'male',
  'hombre',
  'masculina',
]);

/** Acento: cuanto más cerca de Guatemala, mejor. */
const REGION_BONUS: Record<string, number> = { gt: 40, mx: 30, us: 28, '419': 26 };
const LATAM = new Set([
  'ar',
  'bo',
  'cl',
  'co',
  'cr',
  'cu',
  'do',
  'ec',
  'hn',
  'ni',
  'pa',
  'pe',
  'pr',
  'py',
  'sv',
  'uy',
  've',
]);

const words = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const isSpanish = (voice: VoiceLike) => /^es([-_]|$)/i.test(voice.lang);

/** Puntuación de una voz para los llamados. Más es mejor; solo cuenta entre las españolas. */
export function voiceScore(voice: VoiceLike): number {
  const name = voice.name.toLowerCase();
  const tokens = words(voice.name);
  const region = voice.lang.toLowerCase().split(/[-_]/)[1] ?? '';
  let score = 0;

  // Calidad: las neuronales suenan a persona; las demás, a máquina.
  if (/natural|neural/.test(name)) score += 100;
  else if (/online|network/.test(name)) score += 60;
  else if (/premium|enhanced|mejorada|superior/.test(name)) score += 70;
  // Las de Google en Chrome son de calidad aceptable y, en español, voz de mujer.
  if (/google/.test(name)) score += 70;

  if (tokens.some((token) => MALE.has(token))) score -= 200;
  else if (tokens.some((token) => FEMALE.has(token))) score += 50;

  score += REGION_BONUS[region] ?? (LATAM.has(region) ? 20 : region === 'es' ? 10 : 0);
  // A igualdad, las del servicio en línea suelen sonar mejor que las instaladas.
  if (voice.localService === false) score += 5;
  return score;
}

/** Las voces en español, de la mejor a la peor. */
export const rankVoices = <T extends VoiceLike>(voices: readonly T[]): T[] =>
  voices.filter(isSpanish).sort((a, b) => voiceScore(b) - voiceScore(a));

/**
 * La voz con la que se llama: la que se eligió en esta pantalla si el aparato aún la tiene;
 * si no, la mejor. `null` si el aparato no tiene ninguna en español.
 */
export function pickVoice<T extends VoiceLike>(
  voices: readonly T[],
  chosenName: string | null,
): T | null {
  const ranked = rankVoices(voices);
  return ranked.find((voice) => voice.name === chosenName) ?? ranked[0] ?? null;
}

/** Nombre corto para el selector: «Marta (Natural) · Guatemala» en vez del nombre técnico. */
export function voiceLabel(voice: VoiceLike): string {
  const region = new Intl.DisplayNames(['es'], { type: 'region' });
  const code = voice.lang.split(/[-_]/)[1]?.toUpperCase();
  let place = '';
  try {
    place = code && /^[A-Z]{2}$/.test(code) ? (region.of(code) ?? '') : '';
  } catch {
    place = '';
  }
  const short = voice.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Online\s+/i, ' ')
    .replace(/\s+-\s+.*$/, '');
  return place ? `${short} · ${place}` : short;
}
