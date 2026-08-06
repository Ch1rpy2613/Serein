import { describe, expect, it } from 'vitest';
import {
  dateInPeriods,
  gibsTileTemplate,
  nearestAvailableOnOrBefore,
  parseGibsLayerMeta,
  parseGibsPeriodValue,
  resolveGibsDate,
} from './gibs';

describe('gibs', () => {
  const periods = [
    { start: '2024-01-01', end: '2024-05-31' },
    { start: '2024-06-04', end: '2024-06-30' },
  ];

  it('parses P1D period values', () => {
    expect(parseGibsPeriodValue('2024-01-01/2024-05-31/P1D')).toEqual({
      start: '2024-01-01',
      end: '2024-05-31',
    });
  });

  it('resolves gap dates to previous available day', () => {
    expect(nearestAvailableOnOrBefore('2024-06-01', periods)).toBe('2024-05-31');
    expect(dateInPeriods('2024-06-01', periods)).toBe(false);
    expect(dateInPeriods('2024-06-04', periods)).toBe(true);
  });

  it('clamps future dates to default and marks degraded', () => {
    const resolved = resolveGibsDate('2099-01-01', {
      defaultDate: '2024-06-30',
      periods,
    });
    expect(resolved.date).toBe('2024-06-30');
    expect(resolved.degraded).toBe(true);
  });

  it('builds cache-stable tile template with z/y/x.jpeg', () => {
    const url = gibsTileTemplate('2024-06-10');
    expect(url).toContain('VIIRS_SNPP_CorrectedReflectance_TrueColor');
    expect(url).toContain('/2024-06-10/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg');
    expect(url.includes('?')).toBe(false);
  });

  it('parses layer meta from capabilities snippet', () => {
    const xml = `
      <Layer><ows:Identifier>VIIRS_SNPP_CorrectedReflectance_TrueColor</ows:Identifier>
      <Dimension><ows:Identifier>Time</ows:Identifier>
      <Default>2024-06-30</Default>
      <Value>2024-01-01/2024-05-31/P1D</Value>
      <Value>2024-06-04/2024-06-30/P1D</Value>
      </Dimension></Layer>`;
    const meta = parseGibsLayerMeta(xml);
    expect(meta?.defaultDate).toBe('2024-06-30');
    expect(meta?.periods).toHaveLength(2);
  });
});
