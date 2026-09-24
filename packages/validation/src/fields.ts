import { z } from 'zod';
import { codePointString, isoDateTime, regionCode, uuid } from './common.js';

const fieldName = codePointString(1, 160, /\S/);
const areaHa = z.string().regex(/^(?!0+\.00$)\d{1,8}\.\d{2}$/, 'validation.areaHa.format');
const dose = z.string().regex(/^(?!0+\.000$)\d{1,7}\.\d{3}$/, 'validation.dose.format');
const doseUnit = z.enum(['л/га', 'мл/га', 'кг/га', 'г/га']);

const geoJsonRing = z
  .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
  .min(4)
  .max(1000)
  .refine((ring) => {
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    return first[0] === last[0] && first[1] === last[1];
  }, 'validation.geometry.ringNotClosed');

const geoJsonPolygon = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z.array(geoJsonRing).min(1).max(10),
  })
  .strict();

const nullableGeoJsonPolygon = geoJsonPolygon.nullable();

export const FieldInputSchema = z
  .object({
    name: fieldName,
    areaHa,
    regionCode,
    geometry: nullableGeoJsonPolygon.optional(),
  })
  .strict();
export type FieldInput = z.infer<typeof FieldInputSchema>;

export const TreatmentInputSchema = z
  .object({
    substanceId: uuid,
    dose,
    doseUnit,
    appliedAt: isoDateTime,
  })
  .strict();
export type TreatmentInput = z.infer<typeof TreatmentInputSchema>;
