import { describe, expect, it } from 'vitest';
import { pickVoice, rankVoices, voiceLabel, voiceScore } from './voice';

/** Voces como las que traen de verdad Edge, Chrome, Windows y Android. */
const edgeMarta = {
  name: 'Microsoft Marta Online (Natural) - Spanish (Guatemala)',
  lang: 'es-GT',
  localService: false,
};
const edgeAndres = {
  name: 'Microsoft Andres Online (Natural) - Spanish (Guatemala)',
  lang: 'es-GT',
  localService: false,
};
const edgeDalia = {
  name: 'Microsoft Dalia Online (Natural) - Spanish (Mexico)',
  lang: 'es-MX',
  localService: false,
};
const chromeGoogle = {
  name: 'Google español de Estados Unidos',
  lang: 'es-US',
  localService: false,
};
const windowsSabina = {
  name: 'Microsoft Sabina - Spanish (Mexico)',
  lang: 'es-MX',
  localService: true,
};
const windowsRaul = {
  name: 'Microsoft Raul - Spanish (Mexico)',
  lang: 'es-MX',
  localService: true,
};
const windowsHelena = {
  name: 'Microsoft Helena - Spanish (Spain)',
  lang: 'es-ES',
  localService: true,
};
const androidNetwork = { name: 'es-us-x-esf-network', lang: 'es-US', localService: false };
const english = { name: 'Google US English', lang: 'en-US', localService: false };

describe('voz de los llamados', () => {
  it('prefiere la voz neuronal femenina de Guatemala a cualquier otra', () => {
    const ranked = rankVoices([
      windowsRaul,
      windowsSabina,
      chromeGoogle,
      edgeAndres,
      edgeDalia,
      edgeMarta,
      windowsHelena,
      english,
    ]);
    expect(ranked.map((voice) => voice.name)).toEqual([
      edgeMarta.name,
      edgeDalia.name,
      chromeGoogle.name,
      windowsSabina.name,
      windowsHelena.name,
      edgeAndres.name,
      windowsRaul.name,
    ]);
  });

  it('una voz de hombre, por natural que sea, queda por debajo de una de mujer', () => {
    expect(voiceScore(windowsSabina)).toBeGreaterThan(voiceScore(edgeAndres));
  });

  it('en Android, la voz de red antes que la instalada', () => {
    const local = { name: 'es-us-x-esf-local', lang: 'es-US', localService: true };
    expect(rankVoices([local, androidNetwork])[0]).toBe(androidNetwork);
  });

  it('respeta la voz elegida si el aparato la sigue teniendo; si no, la mejor', () => {
    const voices = [edgeMarta, windowsSabina];
    expect(pickVoice(voices, windowsSabina.name)).toBe(windowsSabina);
    expect(pickVoice(voices, 'Una que ya no está')).toBe(edgeMarta);
    expect(pickVoice(voices, null)).toBe(edgeMarta);
    expect(pickVoice([english], null)).toBeNull();
  });

  it('enseña un nombre corto con el país', () => {
    expect(voiceLabel(edgeMarta)).toBe('Marta (Natural) · Guatemala');
    expect(voiceLabel(windowsSabina)).toBe('Sabina · México');
    expect(voiceLabel(chromeGoogle)).toBe('Google español de Estados Unidos · Estados Unidos');
  });
});
