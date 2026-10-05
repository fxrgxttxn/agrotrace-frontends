import { at as storyAt, cmp, iso, plusMinutes } from './time.js';
import type { World } from './world.js';

const LAB_USER: Record<string, string> = { vetlab: 'vetlab.analyst', agrotest: 'agrotest.head' };

export function runScenario(w: World): void {
  const at = (s: string): string => w.story(storyAt(s));
  const steps: { t: string; n: number; fn: (t: string) => void }[] = [];
  const on = (time: string, fn: (t: string) => void): void => {
    steps.push({ t: time.endsWith('Z') ? iso(time) : at(time), n: steps.length, fn });
  };

  const labUser = (testKey: string): string => {
    const t = w.test(testKey);
    const lab = [...w.keys.org.entries()].find(([, o]) => o.id === t.lab_org_id)![0];
    return LAB_USER[lab]!;
  };
  const pass = (testKey: string, sampledAt: string, doneAt: string): void => {
    on(sampledAt, (t) => w.registerLabSample(t, labUser(testKey), testKey));
    on(doneAt, (t) => w.submitLabResults(t, labUser(testKey), testKey));
    on(plusMinutes(at(doneAt), 30), (t) => w.uploadLabProtocol(t, labUser(testKey), testKey));
  };
  const passIfTested = (batchKey: string, sampledAt: string, doneAt: string): void => {
    const k = `${batchKey}:risk`;
    const tested = (): boolean => w.keys.test.has(k);
    on(sampledAt, (t) => tested() && w.registerLabSample(t, labUser(k), k));
    on(doneAt, (t) => tested() && w.submitLabResults(t, labUser(k), k));
    on(plusMinutes(at(doneAt), 30), (t) => tested() && w.uploadLabProtocol(t, labUser(k), k));
  };
  const raw = (
    time: string,
    user: string,
    key: string,
    field: string,
    product: string,
    massKg: string,
    harvested: string,
  ): void =>
    on(time, (t) => w.createBatch(t, user, key, { field, product, massKg, harvestedAt: at(harvested) }));
  const ship = (
    sender: string,
    key: string,
    receiver: string,
    items: string[],
    createdAt: string,
    sentAt: string,
  ): void => {
    on(createdAt, (t) =>
      w.createWaybill(
        t,
        sender,
        key,
        receiver,
        items.map((batch) => ({ batch })),
      ),
    );
    on(sentAt, (t) => w.sendWaybill(t, sender, key));
  };
  const accept = (
    time: string,
    user: string,
    key: string,
    actual: Record<string, { massKg: string; act?: string }> = {},
  ): void => on(time, (t) => w.acceptWaybill(t, user, key, actual));
  const process = (
    time: string,
    user: string,
    inputs: { batch: string; massUsedKg: string }[],
    outputs: { key: string; product: string; massKg: string }[],
  ): void => on(time, (t) => w.processBatches(t, user, inputs, outputs));
  const onSale = (time: string, user: string, batch: string): void =>
    on(time, (t) => w.putOnSale(t, user, batch));
  const sold = (time: string, user: string, batch: string): void =>
    on(time, (t) => w.markSold(t, user, batch));
  const qr = (time: string, user: string, batch: string): void =>
    on(time, (t) => w.createBatchQr(t, user, batch));
  const treat = (
    created: string,
    user: string,
    field: string,
    substance: string,
    dose: string,
    unit: 'л/га' | 'кг/га',
    applied: string,
  ): void => on(created, (t) => w.createTreatment(t, user, field, substance, dose, unit, at(applied)));

  on('2026-05-11 10:00', (t) => w.seedOrganizations(t));
  on('2026-05-12 10:00', (t) => w.seedDictionaries(t, 'admin'));

  on('2026-05-18 09:10', (t) => w.createField(t, 'zarya.agronom', 'zarya-north'));
  on('2026-05-18 09:25', (t) => w.createField(t, 'zarya.agronom', 'zarya-orchard'));
  on('2026-05-18 11:40', (t) => w.createField(t, 'petrov', 'petrov-lowland'));
  on('2026-05-18 11:55', (t) => w.createField(t, 'petrov', 'petrov-pasture'));
  on('2026-05-19 08:30', (t) => w.createField(t, 'lugovaya.zootech', 'lugovaya-meadow'));
  on('2026-05-19 08:45', (t) => w.createField(t, 'lugovaya.zootech', 'lugovaya-floodplain'));
  treat(
    '2026-05-20 14:00',
    'zarya.agronom',
    'zarya-north',
    'saltpeter',
    '150.000',
    'кг/га',
    '2026-05-06 07:00',
  );
  treat('2026-05-20 14:05', 'petrov', 'petrov-lowland', 'npk', '300.000', 'кг/га', '2026-05-08 08:00');
  treat('2026-05-20 16:30', 'petrov', 'petrov-lowland', 'zenkor', '0.600', 'л/га', '2026-05-20 07:30');
  treat(
    '2026-05-21 10:00',
    'lugovaya.zootech',
    'lugovaya-meadow',
    'urea',
    '100.000',
    'кг/га',
    '2026-05-21 06:30',
  );
  treat(
    '2026-05-21 10:10',
    'lugovaya.zootech',
    'lugovaya-floodplain',
    'urea',
    '80.000',
    'кг/га',
    '2026-05-21 07:15',
  );
  treat('2026-06-05 15:00', 'zarya.agronom', 'zarya-north', 'lontrel', '0.300', 'л/га', '2026-06-05 06:00');
  treat('2026-06-10 17:20', 'zarya.agronom', 'zarya-orchard', 'horus', '0.300', 'кг/га', '2026-06-10 06:30');
  treat('2026-06-18 18:00', 'petrov', 'petrov-lowland', 'aktara', '0.080', 'кг/га', '2026-06-18 07:00');
  treat('2026-06-25 16:40', 'zarya.agronom', 'zarya-north', 'falcon', '0.600', 'л/га', '2026-06-25 05:50');
  treat('2026-07-02 19:00', 'petrov', 'petrov-lowland', 'ridomil', '2.500', 'кг/га', '2026-07-02 06:10');
  treat('2026-07-15 16:00', 'zarya.agronom', 'zarya-orchard', 'skor', '0.200', 'л/га', '2026-07-15 06:00');
  treat('2026-08-26 18:30', 'petrov', 'petrov-lowland', 'karate', '0.150', 'л/га', '2026-08-26 06:00');
  treat('2026-09-05 17:00', 'zarya.agronom', 'zarya-north', 'tilt', '0.500', 'л/га', '2026-09-05 06:00');

  raw('2026-06-02 08:00', 'lugovaya.zootech', 'M1', 'lugovaya-meadow', 'rawmilk', '3200', '2026-06-02 05:30');
  pass('M1:risk', '2026-06-02 11:00', '2026-06-03 10:00');
  ship('lugovaya.head', 'wb-M1', 'molkombinat', ['M1'], '2026-06-03 12:00', '2026-06-03 12:05');
  accept('2026-06-03 16:00', 'molkombinat.technolog', 'wb-M1', { M1: { massKg: '3185' } });
  process(
    '2026-06-04 08:00',
    'molkombinat.technolog',
    [{ batch: 'M1', massUsedKg: '3185' }],
    [
      { key: 'milk1', product: 'milk', massKg: '2400' },
      { key: 'tvorog1', product: 'tvorog', massKg: '360' },
    ],
  );
  ship('molkombinat.technolog', 'wb-milk1', 'provizia', ['milk1'], '2026-06-04 10:00', '2026-06-04 10:05');
  ship('molkombinat.technolog', 'wb-tvorog1', 'lavka', ['tvorog1'], '2026-06-04 10:10', '2026-06-04 10:15');
  accept('2026-06-04 15:00', 'provizia.manager', 'wb-milk1');
  qr('2026-06-04 15:30', 'provizia.manager', 'milk1');
  accept('2026-06-04 17:00', 'lavka.head', 'wb-tvorog1');
  onSale('2026-06-05 08:00', 'provizia.manager', 'milk1');
  onSale('2026-06-05 09:00', 'lavka.head', 'tvorog1');
  sold('2026-06-12 18:00', 'lavka.head', 'tvorog1');

  raw(
    '2026-06-22 07:40',
    'lugovaya.zootech',
    'M2',
    'lugovaya-floodplain',
    'rawmilk',
    '4100',
    '2026-06-22 05:00',
  );
  pass('M2:risk', '2026-06-22 10:30', '2026-06-23 09:40');
  ship('lugovaya.head', 'wb-M2', 'molkombinat', ['M2'], '2026-06-23 11:00', '2026-06-23 11:05');
  accept('2026-06-23 18:00', 'molkombinat.technolog', 'wb-M2', { M2: { massKg: '4050' } });
  process(
    '2026-06-24 08:00',
    'molkombinat.technolog',
    [{ batch: 'M2', massUsedKg: '4050' }],
    [{ key: 'milk2', product: 'milk', massKg: '3950' }],
  );
  process(
    '2026-06-25 08:00',
    'molkombinat.technolog',
    [{ batch: 'milk2', massUsedKg: '3950' }],
    [{ key: 'cream1', product: 'cream', massKg: '620' }],
  );
  process(
    '2026-06-26 08:00',
    'molkombinat.head',
    [{ batch: 'cream1', massUsedKg: '620' }],
    [
      { key: 'butter1', product: 'butter', massKg: '150' },
      { key: 'butter2', product: 'butter', massKg: '110' },
    ],
  );
  ship(
    'molkombinat.technolog',
    'wb-butter2',
    'provizia',
    ['butter2'],
    '2026-06-27 09:00',
    '2026-06-27 09:10',
  );
  accept('2026-06-27 14:00', 'provizia.head', 'wb-butter2');
  onSale('2026-06-28 08:30', 'provizia.manager', 'butter2');
  process(
    '2026-06-29 08:00',
    'molkombinat.technolog',
    [{ batch: 'butter1', massUsedKg: '150' }],
    [{ key: 'ghee1', product: 'ghee', massKg: '118' }],
  );
  ship('molkombinat.technolog', 'wb-ghee1', 'koltso', ['ghee1'], '2026-06-30 10:00', '2026-06-30 10:10');
  accept('2026-07-01 11:00', 'koltso.head', 'wb-ghee1');
  qr('2026-07-01 11:20', 'koltso.head', 'ghee1');
  onSale('2026-07-02 08:00', 'koltso.head', 'ghee1');

  raw('2026-07-08 07:30', 'lugovaya.zootech', 'M3', 'lugovaya-meadow', 'rawmilk', '5230', '2026-07-08 05:00');
  pass('M3:risk', '2026-07-08 10:00', '2026-07-09 09:00');
  ship('lugovaya.head', 'wb-M3', 'molkombinat', ['M3'], '2026-07-09 10:30', '2026-07-09 10:35');
  accept('2026-07-09 17:30', 'molkombinat.technolog', 'wb-M3', { M3: { massKg: '5200' } });
  process(
    '2026-07-10 08:00',
    'molkombinat.technolog',
    [{ batch: 'M3', massUsedKg: '5200' }],
    [
      { key: 'milk3', product: 'milk', massKg: '2600' },
      { key: 'tvorog2', product: 'tvorog', massKg: '520' },
      { key: 'cream2', product: 'cream', massKg: '700' },
      { key: 'tvorog3', product: 'tvorog', massKg: '300' },
    ],
  );
  process(
    '2026-07-11 08:00',
    'molkombinat.technolog',
    [{ batch: 'cream2', massUsedKg: '700' }],
    [
      { key: 'butter3', product: 'butter', massKg: '170' },
      { key: 'butter4', product: 'butter', massKg: '150' },
    ],
  );
  ship(
    'molkombinat.technolog',
    'wb-milk3',
    'provizia',
    ['milk3', 'tvorog3'],
    '2026-07-11 09:00',
    '2026-07-11 09:05',
  );
  ship('molkombinat.technolog', 'wb-tvorog2', 'lavka', ['tvorog2'], '2026-07-11 09:15', '2026-07-11 09:20');
  accept('2026-07-11 15:00', 'provizia.manager', 'wb-milk3');
  qr('2026-07-11 15:20', 'provizia.manager', 'milk3');
  accept('2026-07-11 16:30', 'lavka.head', 'wb-tvorog2');
  qr('2026-07-12 07:30', 'molkombinat.head', 'butter3');
  onSale('2026-07-12 08:00', 'provizia.manager', 'milk3');
  onSale('2026-07-12 08:05', 'provizia.manager', 'tvorog3');
  onSale('2026-07-12 09:00', 'lavka.head', 'tvorog2');
  sold('2026-07-20 19:00', 'provizia.manager', 'tvorog3');
  raw(
    '2026-08-05 16:30',
    'lugovaya.zootech',
    'M4',
    'lugovaya-floodplain',
    'rawmilk',
    '3900',
    '2026-08-05 05:10',
  );
  pass('M4:risk', '2026-08-06 08:30', '2026-08-06 16:00');
  ship('lugovaya.head', 'wb-M4', 'molkombinat', ['M4'], '2026-08-06 17:00', '2026-08-06 17:05');
  accept('2026-08-07 18:00', 'molkombinat.technolog', 'wb-M4', { M4: { massKg: '3880' } });
  process(
    '2026-08-08 09:00',
    'molkombinat.technolog',
    [{ batch: 'M4', massUsedKg: '3880' }],
    [{ key: 'milk5', product: 'milk', massKg: '3650' }],
  );
  ship('molkombinat.technolog', 'wb-milk5', 'provizia', ['milk5'], '2026-08-08 11:00', '2026-08-08 11:10');
  accept('2026-08-09 10:00', 'provizia.manager', 'wb-milk5');
  onSale('2026-08-09 12:00', 'provizia.manager', 'milk5');
  sold('2026-08-14 19:30', 'provizia.manager', 'milk5');
  raw('2026-08-24 12:00', 'lugovaya.zootech', 'M5', 'lugovaya-meadow', 'rawmilk', '4480', '2026-08-24 05:20');
  pass('M5:risk', '2026-08-24 14:00', '2026-08-25 15:00');
  ship('lugovaya.head', 'wb-M5', 'molkombinat', ['M5'], '2026-08-25 16:00', '2026-08-25 16:05');
  accept('2026-08-26 07:00', 'molkombinat.technolog', 'wb-M5');
  process(
    '2026-08-26 19:00',
    'molkombinat.technolog',
    [{ batch: 'M5', massUsedKg: '4480' }],
    [
      { key: 'tvorog4', product: 'tvorog', massKg: '640' },
      { key: 'milk6', product: 'milk', massKg: '3600' },
    ],
  );
  qr('2026-08-27 10:30', 'molkombinat.head', 'tvorog4');
  ship('molkombinat.technolog', 'wb-milk6', 'lavka', ['milk6'], '2026-08-27 12:30', '2026-08-27 12:35');
  accept('2026-08-27 17:00', 'lavka.head', 'wb-milk6');
  onSale('2026-08-28 11:00', 'lavka.head', 'milk6');
  sold('2026-09-02 20:00', 'lavka.head', 'milk6');
  raw(
    '2026-09-05 07:30',
    'lugovaya.zootech',
    'M6',
    'lugovaya-floodplain',
    'rawmilk',
    '3750',
    '2026-09-05 05:00',
  );
  passIfTested('M6', '2026-09-05 10:00', '2026-09-06 09:00');
  ship('lugovaya.head', 'wb-M6', 'molkombinat', ['M6'], '2026-09-07 06:30', '2026-09-07 06:35');
  accept('2026-09-07 12:00', 'molkombinat.technolog', 'wb-M6', { M6: { massKg: '3738' } });

  raw('2026-07-25 15:00', 'petrov', 'potato1', 'petrov-lowland', 'potato', '8600', '2026-07-25 06:00');
  pass('potato1:risk', '2026-07-26 09:00', '2026-07-27 08:30');
  ship('petrov', 'wb-potato1', 'provizia', ['potato1'], '2026-07-27 10:00', '2026-07-27 10:05');
  accept('2026-07-28 09:00', 'provizia.manager', 'wb-potato1', { potato1: { massKg: '8540' } });
  onSale('2026-07-29 08:00', 'provizia.manager', 'potato1');
  sold('2026-08-10 20:00', 'provizia.manager', 'potato1');
  raw('2026-08-02 14:00', 'petrov', 'beef1', 'petrov-pasture', 'beef', '640', '2026-08-02 07:00');
  pass('beef1:risk', '2026-08-03 09:00', '2026-08-04 08:00');
  ship('petrov', 'wb-beef1', 'lavka', ['beef1'], '2026-08-04 09:00', '2026-08-04 09:05');
  accept('2026-08-05 08:30', 'lavka.head', 'wb-beef1', { beef1: { massKg: '636.5' } });
  onSale('2026-08-05 16:00', 'lavka.head', 'beef1');
  sold('2026-08-08 19:00', 'lavka.head', 'beef1');
  raw('2026-08-10 14:00', 'petrov', 'potato2', 'petrov-lowland', 'potato', '4200', '2026-08-10 06:00');
  pass('potato2:risk', '2026-08-11 08:00', '2026-08-11 15:00');
  ship('petrov', 'wb-potato2', 'lavka', ['potato2'], '2026-08-12 07:00', '2026-08-12 07:05');
  accept('2026-08-12 13:00', 'lavka.head', 'wb-potato2');
  qr('2026-08-12 13:20', 'lavka.head', 'potato2');
  onSale('2026-08-13 08:00', 'lavka.head', 'potato2');

  raw('2026-07-28 16:00', 'zarya.agronom', 'wheat1', 'zarya-north', 'wheat', '12480', '2026-07-28 06:00');
  pass('wheat1:risk', '2026-07-29 09:00', '2026-07-30 10:00');
  ship('zarya.head', 'wb-wheat1', 'melkombinat', ['wheat1'], '2026-07-30 13:00', '2026-07-30 14:00');
  accept('2026-07-31 10:00', 'melkombinat.head', 'wb-wheat1', {
    wheat1: {
      massKg: '12190',
      act: 'Акт о расхождении № 17 от 31.07.2026: недостача 290 кг (2,32 %) — усушка и потери при перевалке; составлен с водителем перевозчика.',
    },
  });
  process(
    '2026-08-03 08:00',
    'melkombinat.head',
    [{ batch: 'wheat1', massUsedKg: '12190' }],
    [
      { key: 'flour1', product: 'flour', massKg: '8400' },
      { key: 'flour2', product: 'flour', massKg: '900' },
    ],
  );
  ship('melkombinat.head', 'wb-flour1', 'koltso', ['flour1'], '2026-08-04 10:00', '2026-08-04 10:10');
  ship('melkombinat.head', 'wb-flour2', 'provizia', ['flour2'], '2026-08-04 10:20', '2026-08-04 10:30');
  accept('2026-08-05 12:00', 'koltso.head', 'wb-flour1');
  qr('2026-08-05 12:30', 'koltso.head', 'flour1');
  on('2026-08-05 13:00', (t) =>
    w.rejectWaybill(
      t,
      'provizia.head',
      'wb-flour2',
      'Нарушена целостность упаковки: 6 мешков порваны, мука подмочена.',
    ),
  );
  onSale('2026-08-06 08:00', 'koltso.head', 'flour1');
  raw('2026-08-06 15:00', 'zarya.agronom', 'wheat2', 'zarya-north', 'wheat', '10150', '2026-08-06 06:30');
  pass('wheat2:risk', '2026-08-07 09:00', '2026-08-07 15:00');
  ship('zarya.head', 'wb-wheat2', 'melkombinat', ['wheat2'], '2026-08-08 08:00', '2026-08-08 08:10');
  accept('2026-08-09 09:00', 'melkombinat.head', 'wb-wheat2');
  raw(
    '2026-08-12 15:00',
    'zarya.agronom',
    'rapeseed1',
    'zarya-north',
    'rapeseed',
    '6300',
    '2026-08-12 07:00',
  );
  pass('rapeseed1:risk', '2026-08-13 09:00', '2026-08-14 11:00');

  raw('2026-08-18 10:00', 'zarya.agronom', 'apples1', 'zarya-orchard', 'apples', '3100', '2026-08-18 07:00');
  pass('apples1:risk', '2026-08-19 09:00', '2026-08-19 16:00');
  ship('zarya.head', 'wb-apples1', 'provizia', ['apples1'], '2026-08-20 07:30', '2026-08-20 07:35');
  accept('2026-08-20 14:00', 'provizia.manager', 'wb-apples1');
  onSale('2026-08-21 08:00', 'provizia.manager', 'apples1');
  raw('2026-08-25 13:00', 'zarya.agronom', 'apples2', 'zarya-orchard', 'apples', '2800', '2026-08-25 07:00');
  pass('apples2:risk', '2026-08-27 08:00', '2026-08-27 10:00');
  ship('zarya.head', 'wb-apples2', 'koltso', ['apples2'], '2026-08-27 12:00', '2026-08-27 12:05');
  on('2026-08-28 10:00', (t) =>
    w.rejectWaybill(
      t,
      'koltso.head',
      'wb-apples2',
      'Механические повреждения плодов (вмятины, трещины) у 18 % продукции, несоответствие товарному виду.',
    ),
  );
  raw('2026-09-08 09:00', 'zarya.agronom', 'apples3', 'zarya-orchard', 'apples', '3350', '2026-09-08 07:00');
  passIfTested('apples3', '2026-09-09 08:30', '2026-09-10 11:00');
  ship('zarya.head', 'wb-apples3', 'lavka', ['apples3'], '2026-09-18 16:00', '2026-09-18 16:10');

  raw('2026-08-15 16:00', 'petrov', 'carrot1', 'petrov-lowland', 'carrot', '2750', '2026-08-15 07:00');
  pass('carrot1:risk', '2026-08-16 09:00', '2026-08-17 10:00');
  ship('petrov', 'wb-carrot1', 'provizia', ['carrot1'], '2026-08-18 11:00', '2026-08-18 11:05');
  accept('2026-08-18 17:00', 'provizia.manager', 'wb-carrot1');
  onSale('2026-08-19 08:00', 'provizia.manager', 'carrot1');
  on('2026-08-28 19:40', (t) =>
    w.createPublicComplaint(
      t,
      'complaint-carrot',
      'carrot1',
      'Купили морковь в «Провизии» на пр-те Ленина: горчит, внутри чёрные пятна, у ребёнка после неё болел живот.',
      'ivanova.m@example.com',
      '203.0.113.24',
    ),
  );
  on('2026-08-29 09:15', (t) => w.startComplaintReview(t, 'inspector', 'complaint-carrot'));
  on('2026-08-29 10:00', (t) =>
    w.decideComplaint(t, 'inspector', 'complaint-carrot', {
      decision: 'RECALL',
      comment:
        'Жалоба подтверждена осмотром образцов из торгового зала: признаки гнили и порчи. Партия отзывается из продажи.',
      recallKey: 'recall-carrot',
    }),
  );
  on('2026-08-30 11:30', (t) => w.confirmRecallTask(t, 'provizia.manager', 'recall-carrot', 'carrot1'));

  raw('2026-08-22 15:00', 'petrov', 'cabbage1', 'petrov-lowland', 'cabbage', '5400', '2026-08-22 06:30');
  pass('cabbage1:risk', '2026-08-23 09:00', '2026-08-24 11:00');
  ship('petrov', 'wb-cabbage1', 'koltso', ['cabbage1'], '2026-08-25 08:00', '2026-08-25 08:05');
  accept('2026-08-26 09:30', 'koltso.head', 'wb-cabbage1', { cabbage1: { massKg: '5335' } });
  onSale('2026-08-27 11:00', 'koltso.head', 'cabbage1');
  raw('2026-09-18 11:00', 'petrov', 'cabbage2', 'petrov-lowland', 'cabbage', '4600', '2026-09-18 06:00');
  pass('cabbage2:risk', '2026-09-18 14:00', '2026-09-19 07:30');
  on('2026-09-19 08:20', (t) =>
    w.createWaybill(t, 'petrov', 'wb-cabbage2-draft', 'lavka', [{ batch: 'cabbage2' }]),
  );

  raw('2026-09-08 15:00', 'petrov', 'carrot2', 'petrov-lowland', 'carrot', '2900', '2026-09-08 07:30');
  raw('2026-09-10 15:00', 'zarya.agronom', 'barley1', 'zarya-north', 'barley', '9800', '2026-09-10 07:00');
  pass('barley1:risk', '2026-09-11 09:00', '2026-09-14 12:00');
  on('2026-09-16 14:00', (t) =>
    w.createWaybill(t, 'zarya.head', 'wb-barley1-draft', 'melkombinat', [{ batch: 'barley1' }]),
  );
  raw('2026-09-17 16:00', 'zarya.agronom', 'wheat3', 'zarya-north', 'wheat', '11200', '2026-09-17 06:30');
  on('2026-09-18 09:00', (t) => w.registerLabSample(t, labUser('wheat3:risk'), 'wheat3:risk'));
  on('2026-09-15 18:10', (t) =>
    w.createPublicComplaint(
      t,
      'complaint-flour',
      'flour1',
      'Мука из «Золотого кольца» горчит, в пакете комочки и затхлый запах, выпечка не поднимается.',
      null,
      '198.51.100.7',
    ),
  );
  on('2026-09-16 10:00', (t) =>
    w.decideComplaint(t, 'inspector.head', 'complaint-flour', {
      decision: 'LAB_TEST',
      comment: 'Назначен внеплановый анализ муки на микотоксины.',
      lab: 'vetlab',
      testKey: 'flour1:complaint',
    }),
  );
  on('2026-09-17 12:40', (t) =>
    w.createPublicComplaint(
      t,
      'complaint-butter',
      'butter2',
      'Масло сливочное с прогорклым привкусом, хотя срок годности ещё не истёк.',
      '+7 903 555-01-77',
      '203.0.113.81',
    ),
  );
  on('2026-09-18 09:30', (t) => w.startComplaintReview(t, 'inspector.head', 'complaint-butter'));
  on('2026-09-19 19:30', (t) =>
    w.createPublicComplaint(
      t,
      'complaint-potato',
      'potato2',
      'Картофель зелёный под кожурой, много проросших клубней.',
      null,
      '192.0.2.45',
    ),
  );

  on('2026-09-15 18:30', (t) => w.createLabTest(t, 'inspector.head', 'M3:control', 'M3', 'agrotest'));
  on('2026-09-16 11:30', (t) => w.registerLabSample(t, 'agrotest.head', 'M3:control'));
  ship('molkombinat.technolog', 'wb-butter4', 'koltso', ['butter4'], '2026-09-18 06:00', '2026-09-18 06:10');
  on('2026-09-18 14:20', (t) =>
    w.submitLabResults(t, 'agrotest.head', 'M3:control', { tetra: '0.034' }, 'recall-milk'),
  );
  on('2026-09-18 14:50', (t) => w.uploadLabProtocol(t, 'agrotest.head', 'M3:control'));
  on('2026-09-18 16:00', (t) => w.confirmRecallTask(t, 'provizia.manager', 'recall-milk', 'milk3'));
  raw('2026-09-19 10:15', 'lugovaya.zootech', 'M7', 'lugovaya-meadow', 'rawmilk', '3620', '2026-09-19 05:10');

  raw('2026-09-19 11:30', 'zarya.agronom', 'barley2', 'zarya-north', 'barley', '7400', '2026-09-19 06:00');
  on('2026-09-19 13:00', (t) => w.registerLabSample(t, labUser('barley2:risk'), 'barley2:risk'));
  on('2026-09-19 17:00', (t) =>
    w.submitLabResults(t, labUser('barley2:risk'), 'barley2:risk', { don: '1.450' }, 'recall-barley'),
  );
  on('2026-09-19 17:30', (t) => w.uploadLabProtocol(t, labUser('barley2:risk'), 'barley2:risk'));

  on('2026-09-20 07:00', (t) =>
    w.createRecall(
      t,
      'inspector.head',
      'recall-cream',
      'cream1',
      'Плановая проверка Молкомбината: нарушение режима пастеризации на линии сливок, продукция линии отзывается.',
      true,
    ),
  );

  steps.sort((a, b) => cmp(a.t, b.t) || a.n - b.n);
  for (const s of steps) s.fn(s.t);
  w.finish();
}
