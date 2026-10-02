// Credits of the product photos (R76 note: the public batch page shows the author and the license of the product
// photo). The contract has no credit field (PublicBatch.product carries only `imageUrl`), so the credits of the seed
// photos (db/seed/ATTRIBUTION.md, Wikimedia Commons) are kept here by product name — a test keeps the table equal to
// ATTRIBUTION.md + db/seed/data/products.json. A photo uploaded later (not a seed one) has no known credit: none shown.

export interface PhotoCredit {
  author: string;
  license: string;
  licenseUrl: string;
  source: string;
}

const CC = 'https://creativecommons.org/licenses';
const WIKI = 'https://commons.wikimedia.org/wiki/File:';

export const PHOTO_CREDITS: Record<string, PhotoCredit> = {
  'Пшеница мягкая': {
    author: 'Raman Deep',
    license: 'CC BY-SA 4.0',
    licenseUrl: `${CC}/by-sa/4.0`,
    source: `${WIKI}Grains_of_wheat_01.jpg`,
  },
  'Ячмень пивоваренный': {
    author: 'Sanjay Acharya',
    license: 'CC BY-SA 4.0',
    licenseUrl: `${CC}/by-sa/4.0`,
    source: `${WIKI}Barley_Seeds.jpg`,
  },
  Рапс: {
    author: 'Daniel Schwen',
    license: 'CC BY-SA 2.5',
    licenseUrl: `${CC}/by-sa/2.5`,
    source: `${WIKI}Rapsfeld_2007.jpg`,
  },
  'Картофель продовольственный': {
    author: 'Ruslan V. Albitsky aka pauk',
    license: 'CC BY-SA 3.0',
    licenseUrl: `${CC}/by-sa/3.0`,
    source: `${WIKI}Potato_tubers_in_pail.jpg`,
  },
  'Морковь столовая': {
    author: 'domdomegg',
    license: 'CC BY 4.0',
    licenseUrl: `${CC}/by/4.0`,
    source: `${WIKI}Carrots_at_Ljubljana_Central_Market.JPG`,
  },
  'Капуста белокочанная': {
    author: '4028mdk09',
    license: 'CC BY-SA 3.0',
    licenseUrl: `${CC}/by-sa/3.0`,
    source: `${WIKI}Wei%C3%9Fkohl_Brassica_oleracea_var._capitata_2011.JPG`,
  },
  Яблоки: {
    author: 'Oxfordian Kissuth',
    license: 'CC BY-SA 3.0',
    licenseUrl: `${CC}/by-sa/3.0`,
    source: `${WIKI}Apples_in_a_basket.jpg`,
  },
  'Молоко сырое коровье': {
    author: 'Irish American Mom',
    license: 'CC BY 2.0',
    licenseUrl: `${CC}/by/2.0`,
    source: `${WIKI}Three_Milk_Churns.jpg`,
  },
  'Говядина охлаждённая': {
    author: 'Jen Arrr',
    license: 'CC BY-SA 2.0',
    licenseUrl: `${CC}/by-sa/2.0`,
    source: `${WIKI}Raw_Meat_(6737753521).jpg`,
  },
  'Молоко пастеризованное 3,2%': {
    author: 'NIAID',
    license: 'CC BY 2.0',
    licenseUrl: `${CC}/by/2.0`,
    source: `${WIKI}Glass_of_Milk_(33657535532).jpg`,
  },
  'Сливки 20%': {
    author: 'Aleksey Pogrebnoj-Alexandroff',
    license: 'CC BY-SA 3.0',
    licenseUrl: `${CC}/by-sa/3.0`,
    source: `${WIKI}Milk_heavy_cream.jpg`,
  },
  'Масло сливочное 82,5%': {
    author: 'Salicyna',
    license: 'CC BY-SA 4.0',
    licenseUrl: `${CC}/by-sa/4.0`,
    source: `${WIKI}Block_of_butter_2020-09-28_2949b.jpg`,
  },
  'Творог 9%': {
    author: 'Loyna',
    license: 'CC BY-SA 2.5',
    licenseUrl: `${CC}/by-sa/2.5`,
    source: `${WIKI}%D0%A2%D0%B2%D0%BE%D1%80%D0%BE%D0%B3.jpg`,
  },
  'Мука пшеничная высшего сорта': {
    author: 'congerdesign',
    license: 'CC0',
    licenseUrl: 'http://creativecommons.org/publicdomain/zero/1.0/deed.en',
    source: `${WIKI}Wheat_flour_01.jpg`,
  },
  'Масло топлёное 99%': {
    author: 'Rainer Z ...',
    license: 'CC BY-SA 3.0',
    licenseUrl: `${CC}/by-sa/3.0`,
    source: `${WIKI}Butterschmalz-3.jpg`,
  },
};

/** The credit of a product photo by the product name, or null when it is not a seed photo. */
export function photoCredit(productName: string): PhotoCredit | null {
  return Object.hasOwn(PHOTO_CREDITS, productName) ? PHOTO_CREDITS[productName]! : null;
}
