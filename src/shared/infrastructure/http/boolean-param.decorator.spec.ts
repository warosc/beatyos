import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { BooleanParam } from './boolean-param.decorator';

class Query {
  @BooleanParam()
  flag?: boolean;
}

const parse = (raw: unknown): { value: boolean | undefined; valid: boolean } => {
  const instance = plainToInstance(Query, { flag: raw });
  return { value: instance.flag, valid: validateSync(instance).length === 0 };
};

describe('BooleanParam', () => {
  it('interpreta la cadena "false" como falso', () => {
    // Es el caso que motivó el decorador: con `@Type(() => Boolean)`, `Boolean('false')` es
    // `true`, así que el sistema hacía lo contrario de lo que se le pedía. En una foto de
    // clienta eso significaba conceder un permiso de publicación explícitamente denegado.
    expect(parse('false')).toEqual({ value: false, valid: true });
  });

  it('interpreta la cadena "true" como verdadero', () => {
    expect(parse('true')).toEqual({ value: true, valid: true });
  });

  it('admite 1 y 0, que es lo que envían algunos formularios', () => {
    expect(parse('1').value).toBe(true);
    expect(parse('0').value).toBe(false);
  });

  it('no distingue mayúsculas ni espacios sobrantes', () => {
    expect(parse(' TRUE ').value).toBe(true);
    expect(parse('False').value).toBe(false);
  });

  it('deja pasar un booleano de verdad sin tocarlo', () => {
    // Un cuerpo JSON envía booleanos nativos; solo la query y el multipart mandan texto.
    expect(parse(true).value).toBe(true);
    expect(parse(false).value).toBe(false);
  });

  it('es opcional: ausente sigue siendo ausente', () => {
    expect(parse(undefined)).toEqual({ value: undefined, valid: true });
    expect(parse('')).toEqual({ value: undefined, valid: true });
  });

  it('rechaza lo que no reconoce en lugar de adivinar', () => {
    // Convertir «quizá» a `false` en silencio escondería un error de quien llama.
    expect(parse('quizá').valid).toBe(false);
    expect(parse('2').valid).toBe(false);
  });
});
