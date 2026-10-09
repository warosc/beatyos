import { describe, expect, it } from 'vitest';
import { daysInMonth, formatBirthday, splitBirthday, toBirthday } from './birthday';

describe('cumpleaños sin año', () => {
  it('se muestra con día y mes', () => {
    expect(formatBirthday('04-17')).toBe('17 de abril');
    expect(formatBirthday('12-01')).toBe('1 de diciembre');
    expect(formatBirthday(null)).toBeNull();
  });

  it('se arma y se separa para los selectores', () => {
    expect(toBirthday('7', '3')).toBe('03-07');
    expect(toBirthday('7', '')).toBeNull();
    expect(splitBirthday('03-07')).toEqual({ day: '7', month: '3' });
    expect(splitBirthday(null)).toEqual({ day: '', month: '' });
  });

  it('febrero llega al 29 y abril al 30', () => {
    expect(daysInMonth(2)).toBe(29);
    expect(daysInMonth(4)).toBe(30);
  });
});
