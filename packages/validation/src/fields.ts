import { z } from 'zod';
import { codePointString, errorMap, isoDateTime, regionCode, uuid } from './common.js';

const fieldName = codePointString(1, 160, /\S/);
const areaHa = z.string({ errorMap }).regex(/^(?!0+\.00$)\d{1,8}\.\d{2}$/, 'validation.areaHa.format');
const dose = z.string({ errorMap }).regex(/^(?!0+\.000$)\d{1,7}\.\d{3}$/, 'validation.dose.format');
const doseUnit = z.enum(['л/га', 'мл/га', 'кг/га', 'г/га'], { errorMap });

const longitude = z.number({ errorMap }).min(-180).max(180);
const latitude = z.number({ errorMap }).min(-90).max(90);

const geoJsonRing = z
  .array(z.tuple([longitude, latitude], { errorMap }), { errorMap })
  .min(4)
  .max(1000)
  .refine((ring) => {
    if (ring.length === 0) return true;
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    return first[0] === last[0] && first[1] === last[1];
  }, 'validation.geometry.ringNotClosed');

const geoJsonPolygon = z
  .object(
    {
      type: z.literal('Polygon', { errorMap }),
      coordinates: z.array(geoJsonRing, { errorMap }).min(1).max(10),
    },
    { errorMap },
  )
  .strict();

const nullableGeoJsonPolygon = geoJsonPolygon.nullable();

export const FieldInputSchema = z
  .object(
    {
      name: fieldName,
      areaHa,
      regionCode,
      geometry: nullableGeoJsonPolygon.optional(),
    },
    { errorMap },
  )
  .strict();
export type FieldInput = z.infer<typeof FieldInputSchema>;

export const TreatmentInputSchema = z
  .object(
    {
      substanceId: uuid,
      dose,
      doseUnit,
      appliedAt: isoDateTime,
    },
    { errorMap },
  )
  .strict();
export type TreatmentInput = z.infer<typeof TreatmentInputSchema>;
