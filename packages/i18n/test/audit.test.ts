import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditFieldLabel, auditValue, createT, formatLocalDateTime } from '../src/index';
import ru from '../locales/ru.json' with { type: 'json' };

const t = createT('ru');

describe('audit diff', () => {
  it('a field of the API by its label; an unknown field as it is', () => {
    expect(auditFieldLabel(t, 'massKg')).toBe('Масса, кг');
    expect(auditFieldLabel(t, 'deletedAt')).toBe('Удалено');
    expect(auditFieldLabel(t, 'isOrgAdmin')).toBe('Руководитель организации');
    expect(auditFieldLabel(t, 'cowCount')).toBe('cowCount');
  });

  it('every field a backend writes into a diff has a label in both locales', () => {
    const fields = Object.keys((ru as { audit: { fields: Record<string, string> } }).audit.fields);
    expect(fields.length).toBeGreaterThan(80);
    for (const f of ['productId', 'indicatorId', 'maxValue', 'regionId', 'totpSecret', 'channels'])
      expect(fields).toContain(f);
  });

  it('values: null, instants, dates, booleans, statuses, the rest', () => {
    expect(auditValue(t, null, 'ru')).toBe('—');
    expect(auditValue(t, '2026-08-01T08:15:00Z', 'ru')).toBe(
      formatLocalDateTime('2026-08-01T08:15:00Z', 'ru'),
    );
    expect(auditValue(t, '2026-08-01T08:15:00.123+03:00', 'ru')).toBe(
      formatLocalDateTime('2026-08-01T08:15:00.123+03:00', 'ru'),
    );
    expect(auditValue(t, '2026-08-14', 'ru')).toBe('14.08.2026');
    expect(auditValue(t, true, 'ru')).toBe('да');
    expect(auditValue(t, false, 'ru')).toBe('нет');
    expect(auditValue(t, 'Approved', 'ru', { field: 'status', entityType: 'batch' })).toBe('Допущена');
    expect(auditValue(t, 'SUSPENDED', 'ru', { field: 'status', entityType: 'organization' })).toBe(
      'Приостановлена',
    );
    expect(auditValue(t, 'Approved', 'ru', { field: 'status', entityType: 'product' })).toBe('Approved');
    expect(auditValue(t, '12480.000', 'ru')).toBe('12 480');
    expect(auditValue(t, '***', 'ru')).toBe('***');
    expect(auditValue(t, 3, 'ru')).toBe('3');
    expect(auditValue(t, { email: true }, 'ru')).toBe('{"email":true}');
  });
});

describe('audit diff', () => {
  it('an action (operationId, system.<job>, seed) by its label; an unknown one as it is', () => {
    expect(auditActionLabel(t, 'deleteDictionaryEntry')).toBe('Удаление записи справочника');
    expect(auditActionLabel(t, 'sendWaybill')).toBe('Отгрузка накладной');
    expect(auditActionLabel(t, 'system.vsdImport')).toBe('Импорт ВСД (система)');
    expect(auditActionLabel(t, 'seed')).toBe('Начальное наполнение');
    expect(auditActionLabel(t, 'milkCow')).toBe('milkCow');
  });

  it('decimals in the locale without trailing zeros; masses as masses; names of referenced records', () => {
    expect(auditValue(t, '0.010000', 'ru')).toBe('0,01');
    expect(auditValue(t, '3.50', 'ru')).toBe('3,5');
    expect(auditValue(t, '2.000', 'ru')).toBe('2');
    expect(auditValue(t, '12480.000', 'ru', { field: 'massKg', entityType: 'batch' })).toBe('12 480,000');
    expect(auditValue(t, 0.95, 'ru')).toBe('0,95');
    const resolve = (field: string, v: string) =>
      field === 'productId' && v === 'p1' ? 'Пшеница' : undefined;
    expect(auditValue(t, 'p1', 'ru', { field: 'productId', entityType: 'norm', resolve })).toBe('Пшеница');
    expect(auditValue(t, 'p2', 'ru', { field: 'productId', entityType: 'norm', resolve })).toBe('p2');
  });
});
