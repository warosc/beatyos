import { DomainValidationError } from '../errors';
import { Email, PersonName, Phone } from './contact.vo';

describe('Email', () => {
  it('normaliza a minúsculas y sin espacios', () => {
    // La normalización ocurre en un único sitio: si viviera en cada caso de uso, el día
    // que uno la olvidara aparecerían fichas duplicadas por diferencia de mayúsculas.
    expect(Email.create('  Ana@Salon.ES  ').value).toBe('ana@salon.es');
  });

  it('acepta direcciones legítimas que las expresiones "completas" suelen rechazar', () => {
    expect(() => Email.create('ana+citas@salon.museum')).not.toThrow();
    expect(() => Email.create('a@b.co')).not.toThrow();
    expect(() => Email.create('nombre.apellido@sub.dominio.es')).not.toThrow();
  });

  it('rechaza errores de tecleo evidentes', () => {
    expect(() => Email.create('sin-arroba.es')).toThrow(DomainValidationError);
    expect(() => Email.create('sin@dominio')).toThrow(DomainValidationError);
    expect(() => Email.create('con espacio@salon.es')).toThrow(DomainValidationError);
    expect(() => Email.create('@salon.es')).toThrow(DomainValidationError);
  });

  it('rechaza una dirección vacía', () => {
    expect(() => Email.create('')).toThrow(/obligatorio/);
    expect(() => Email.create('   ')).toThrow(/obligatorio/);
  });

  it('rechaza direcciones más largas de lo que admite SMTP', () => {
    expect(() => Email.create(`${'a'.repeat(250)}@salon.es`)).toThrow(/254/);
  });

  it('createOptional distingue "sin correo" de "correo inválido"', () => {
    expect(Email.createOptional(null)).toBeNull();
    expect(Email.createOptional(undefined)).toBeNull();
    expect(Email.createOptional('   ')).toBeNull();
    expect(Email.createOptional('ana@salon.es')?.value).toBe('ana@salon.es');
    expect(() => Email.createOptional('roto')).toThrow(DomainValidationError);
  });

  it('expone el dominio', () => {
    expect(Email.create('ana@salon.es').domain).toBe('salon.es');
  });

  it('enmascara para logs sin revelar la dirección', () => {
    // Un correo es dato personal y no debe aparecer entero en un log de aplicación.
    const masked = Email.create('anabel@gmail.com').masked();
    expect(masked).toBe('an****@gmail.com');
    expect(masked).not.toContain('anabel');
  });

  it('enmascara también direcciones muy cortas', () => {
    expect(Email.create('a@b.es').masked()).toBe('a*@b.es');
  });

  it('compara por contenido', () => {
    expect(Email.create('ana@salon.es').equals(Email.create('ANA@SALON.ES'))).toBe(true);
    expect(Email.create('ana@salon.es').equals(Email.create('otra@salon.es'))).toBe(false);
  });

  it('serializa como cadena simple', () => {
    expect(Email.create('ana@salon.es').toJSON()).toBe('ana@salon.es');
    expect(String(Email.create('ana@salon.es'))).toBe('ana@salon.es');
  });
});

describe('Phone', () => {
  it('normaliza quitando separadores de escritura', () => {
    // La recepcionista teclea el número como lo tiene apuntado; el sistema lo guarda
    // siempre igual para que la búsqueda funcione.
    expect(Phone.create('+34 600 11 12 22').value).toBe('+34600111222');
    expect(Phone.create('(600) 111-222').value).toBe('600111222');
    expect(Phone.create('600.111.222').value).toBe('600111222');
  });

  it('acepta números con y sin prefijo internacional', () => {
    expect(() => Phone.create('+34600111222')).not.toThrow();
    expect(() => Phone.create('600111222')).not.toThrow();
  });

  it('rechaza números imposibles por longitud o forma', () => {
    expect(() => Phone.create('12345')).toThrow(DomainValidationError);
    expect(() => Phone.create('+3460011122233344')).toThrow(DomainValidationError);
    expect(() => Phone.create('0600111222')).toThrow(DomainValidationError);
    expect(() => Phone.create('teléfono')).toThrow(DomainValidationError);
  });

  it('rechaza un teléfono vacío', () => {
    expect(() => Phone.create('')).toThrow(/obligatorio/);
  });

  it('createOptional trata la cadena vacía como ausencia', () => {
    expect(Phone.createOptional('')).toBeNull();
    expect(Phone.createOptional(null)).toBeNull();
    expect(Phone.createOptional('+34600111222')?.value).toBe('+34600111222');
  });

  it('enmascara dejando solo los últimos dígitos', () => {
    expect(Phone.create('+34600111222').masked()).toBe('*********222');
  });

  it('compara por contenido normalizado', () => {
    expect(Phone.create('+34 600 111 222').equals(Phone.create('+34600111222'))).toBe(true);
  });

  it('serializa como cadena simple', () => {
    expect(Phone.create('+34600111222').toJSON()).toBe('+34600111222');
    expect(String(Phone.create('+34600111222'))).toBe('+34600111222');
  });
});

describe('PersonName', () => {
  it('recorta los espacios sobrantes', () => {
    const name = PersonName.create('  Rosa  ', '  Iglesias  ');
    expect(name.firstName).toBe('Rosa');
    expect(name.lastName).toBe('Iglesias');
  });

  it('compone el nombre completo y las iniciales', () => {
    const name = PersonName.create('Rosa', 'Iglesias');
    expect(name.full).toBe('Rosa Iglesias');
    expect(name.initials).toBe('RI');
    expect(String(name)).toBe('Rosa Iglesias');
  });

  it('exige nombre y apellidos', () => {
    expect(() => PersonName.create('', 'Iglesias')).toThrow(/nombre es obligatorio/);
    expect(() => PersonName.create('Rosa', '   ')).toThrow(/apellidos son obligatorios/);
  });

  it('limita la longitud de cada parte', () => {
    expect(() => PersonName.create('a'.repeat(101), 'Iglesias')).toThrow(/100/);
    expect(() => PersonName.create('Rosa', 'a'.repeat(101))).toThrow(/100/);
  });

  it('compara por contenido', () => {
    expect(
      PersonName.create('Rosa', 'Iglesias').equals(PersonName.create('Rosa', 'Iglesias')),
    ).toBe(true);
    expect(PersonName.create('Rosa', 'Iglesias').equals(PersonName.create('Ana', 'Iglesias'))).toBe(
      false,
    );
  });

  it('un value object no es igual a otro de distinta clase', () => {
    // La comparación mira el constructor: sin eso, dos objetos con las mismas claves
    // pero semántica distinta se considerarían iguales.
    const name = PersonName.create('Rosa', 'Iglesias');
    expect(name.equals(Email.create('rosa@salon.es') as unknown as PersonName)).toBe(false);
  });
});
