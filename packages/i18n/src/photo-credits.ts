export interface PhotoCredit {
  author: string;
  license: string;
  licenseUrl: string;
  source: string;
}

const WIKI = 'https://commons.wikimedia.org/wiki/File:';

const licenseUrl = (license: string): string =>
  license === 'CC0'
    ? 'http://creativecommons.org/publicdomain/zero/1.0/deed.en'
    : `https://creativecommons.org/licenses/${license.slice(3).toLowerCase().replace(' ', '/')}`;

const ROWS: [string, string, string, string][] = [
  ['2ca5ff5f', 'Raman Deep', 'CC BY-SA 4.0', 'Grains_of_wheat_01.jpg'],
  ['d889eb60', 'Sanjay Acharya', 'CC BY-SA 4.0', 'Barley_Seeds.jpg'],
  ['171ed2a1', 'Daniel Schwen', 'CC BY-SA 2.5', 'Rapsfeld_2007.jpg'],
  ['faa2f00c', 'Ruslan V. Albitsky aka pauk', 'CC BY-SA 3.0', 'Potato_tubers_in_pail.jpg'],
  ['291fb06b', 'domdomegg', 'CC BY 4.0', 'Carrots_at_Ljubljana_Central_Market.JPG'],
  ['e3171b1c', '4028mdk09', 'CC BY-SA 3.0', 'Wei%C3%9Fkohl_Brassica_oleracea_var._capitata_2011.JPG'],
  ['963c7276', 'Oxfordian Kissuth', 'CC BY-SA 3.0', 'Apples_in_a_basket.jpg'],
  ['3c14c3d3', 'Irish American Mom', 'CC BY 2.0', 'Three_Milk_Churns.jpg'],
  ['c5d937a6', 'Jen Arrr', 'CC BY-SA 2.0', 'Raw_Meat_(6737753521).jpg'],
  ['f0bc41cf', 'NIAID', 'CC BY 2.0', 'Glass_of_Milk_(33657535532).jpg'],
  ['69bae4f7', 'Aleksey Pogrebnoj-Alexandroff', 'CC BY-SA 3.0', 'Milk_heavy_cream.jpg'],
  ['bff76077', 'Salicyna', 'CC BY-SA 4.0', 'Block_of_butter_2020-09-28_2949b.jpg'],
  ['f47160aa', 'Loyna', 'CC BY-SA 2.5', '%D0%A2%D0%B2%D0%BE%D1%80%D0%BE%D0%B3.jpg'],
  ['b4d82aa5', 'congerdesign', 'CC0', 'Wheat_flour_01.jpg'],
  ['66277b5c', 'Rainer Z ...', 'CC BY-SA 3.0', 'Butterschmalz-3.jpg'],
];

export const PHOTO_CREDITS: Record<string, PhotoCredit> = Object.fromEntries(
  ROWS.map(([id, author, license, file]) => [
    id,
    { author, license, licenseUrl: licenseUrl(license), source: WIKI + file },
  ]),
);

export function photoCredit(imageUrl: string | null | undefined): PhotoCredit | null {
  const id = imageUrl
    ? /\/files\/([0-9a-f]{8})-[0-9a-f]{4}-5[0-9a-f-]{21}(?:[?#]|$)/.exec(imageUrl)?.[1]
    : undefined;
  return id !== undefined && Object.hasOwn(PHOTO_CREDITS, id) ? PHOTO_CREDITS[id]! : null;
}
