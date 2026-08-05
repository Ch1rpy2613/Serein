export {
  solarPosition,
  sunriseSunset,
  isAstronomicalNight,
  TZ_OFFSET_MINUTES,
  type SolarPosition,
} from './sun';
export {
  moonPhase,
  moonIllumination,
  moonPosition,
  moonriseMoonset,
  julianDateUTC,
  type MoonPosition,
} from './moon';
export { galacticCenterAlt, galacticWindow, type GalacticWindow } from './milkyway';

import { CITY, type DayData } from '../contracts';
import { moonIllumination, moonPhase, moonriseMoonset } from './moon';
import { sunriseSunset } from './sun';

/** 用本地天文库填充 DayData.astro（mock / 月相字段；日出日落可被 API 覆盖） */
export function computeAstro(date: string, lat = CITY.lat, lon = CITY.lon): DayData['astro'] {
  const sun = sunriseSunset(date, lat, lon);
  const moon = moonriseMoonset(date, lat, lon);
  return {
    sunrise: sun.sunrise ?? 360,
    sunset: sun.sunset ?? 1080,
    moonrise: moon.moonrise,
    moonset: moon.moonset,
    moonPhase: moonPhase(date),
    moonIllumination: moonIllumination(date),
  };
}
