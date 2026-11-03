/** La marca que la API añade al nombre de una profesional dada de baja (ADR-0028). */
export const RETIRED_SUFFIX = ' (dada de baja)';

/**
 * El nombre sin la marca. En el historial interno se deja, para que se lea que ya no está;
 * en papeles para la clienta, como el recibo, sobra.
 */
export const withoutRetiredMark = (name: string) =>
  name.endsWith(RETIRED_SUFFIX) ? name.slice(0, -RETIRED_SUFFIX.length) : name;
