/**
 * 探空指数：标准伪绝热地面气块法（surface-based parcel）。
 *
 * 文献 / 公式来源：
 * - Bolton, D., 1980: The computation of equivalent potential temperature.
 *   Mon. Wea. Rev., 108, 1046–1053.  （LCL 温度式 (22)；饱和水汽压近似）
 * - Doswell & Rasmussen, 1994: The effect of neglecting the virtual
 *   temperature correction on CAPE calculations. Wea. Forecasting, 9, 625–629.
 * - Emanuel, K. A., 1994: Atmospheric Convection. Oxford Univ. Press.
 *   （伪绝热抬升、CAPE/CIN 对 ln p 积分）
 * - WMO / Alduchov & Eskridge, 1996: Improved Magnus form for saturation
 *   vapor pressure. J. Appl. Meteor., 35, 601–609.  （露点 / 饱和水汽压）
 *
 * CAPE = Rd ∫_LFC^EL (Tv,p − Tv,e) d ln p
 * CIN  = Rd ∫_SFC^LFC (Tv,p − Tv,e) d ln p   （负浮力段，报告为 ≤ 0）
 * LI   = T_env(500 hPa) − T_parcel(500 hPa)
 * PW   ≈ (1/g) ∫ q dp  （kg m⁻² ≈ mm）
 */

import type { ProfilePoint } from '../../contracts';

/** 干空气气体常数 J/(kg·K) */
const RD = 287.05;
/** 水汽气体常数 J/(kg·K) */
const RV = 461.51;
/** 干空气定压比热 J/(kg·K) */
const CPD = 1005.7;
/** 汽化潜热 J/kg（Bolton 常数近似） */
const LV0 = 2.501e6;
/** ε = Rd/Rv */
const EPS = RD / RV;
/** Poisson 指数 κ = Rd/cpd */
const KAPPA = RD / CPD;
/** 参考气压 hPa */
const P_REF = 1000;
/** 重力 m/s² */
const G = 9.80665;

export interface SoundingIndices {
  /** 对流有效位能 J/kg */
  cape: number;
  /** 对流抑制能量 J/kg（≤ 0） */
  cin: number;
  /** 抬升凝结高度 m（AGL，相对最低层） */
  lclM: number;
  /** 抬升指数 °C */
  li: number;
  /** 整层可降水量 mm */
  pw: number;
}

export interface ParcelPoint {
  pressure: number;
  temperature: number;
  heightM: number;
  /** dry = LCL 以下干绝热；moist = LCL 以上伪绝热 */
  stage: 'dry' | 'moist';
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Magnus / Alduchov–Eskridge：饱和水汽压 (hPa)，T 为 °C。
 * es = 6.112 exp(17.62 T / (243.12 + T))
 */
export function saturationVaporPressureHpa(tC: number): number {
  return 6.112 * Math.exp((17.62 * tC) / (243.12 + tC));
}

/**
 * Magnus 反解：由温度与相对湿度求露点 °C。
 * RH ≤ 100% 时恒有 Td ≤ T（数值上再 clamp）。
 */
export function dewPointFromRh(tC: number, rh: number): number {
  const rhClamped = clamp(rh, 0.01, 100);
  const b = 17.62;
  const c = 243.12;
  const g = Math.log(rhClamped / 100) + (b * tC) / (c + tC);
  const td = (c * g) / (b - g);
  return Math.min(td, tC);
}

/** 饱和混合比 kg/kg（相对干空气） */
export function saturationMixingRatio(tC: number, pHpa: number): number {
  const es = saturationVaporPressureHpa(tC);
  const p = Math.max(pHpa, es + 0.01);
  return (EPS * es) / (p - es);
}

/** 水汽混合比 kg/kg */
export function mixingRatioFromRh(tC: number, rh: number, pHpa: number): number {
  return saturationMixingRatio(tC, pHpa) * clamp(rh, 0, 100) / 100;
}

/** 虚温 K（Doswell & Rasmussen 1994） */
export function virtualTemperatureK(tC: number, mixingRatioKgKg: number): number {
  const tK = tC + 273.15;
  const r = Math.max(0, mixingRatioKgKg);
  return tK * (1 + r / EPS) / (1 + r);
}

/** 位温 K（干空气 Poisson） */
export function potentialTemperatureK(tC: number, pHpa: number): number {
  return (tC + 273.15) * (P_REF / Math.max(pHpa, 1)) ** KAPPA;
}

/** 干绝热：给定 θ(K) 与气压 → 温度 °C */
export function dryAdiabatTemperatureC(thetaK: number, pHpa: number): number {
  return thetaK * (Math.max(pHpa, 1) / P_REF) ** KAPPA - 273.15;
}

/**
 * Bolton (1980) eq. 22：抬升凝结温度 (K)。
 * T、Td 输入为 Kelvin。
 */
export function lclTemperatureK(tK: number, tdK: number): number {
  const t = Math.max(tK, 1);
  const td = clamp(tdK, 1, t);
  return 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56;
}

/** LCL 气压 hPa：沿干绝热从地面抬至 Tlcl */
export function lclPressureHpa(tC: number, tdC: number, pHpa: number): number {
  const tK = tC + 273.15;
  const tdK = tdC + 273.15;
  const tlcl = lclTemperatureK(tK, tdK);
  return pHpa * (tlcl / tK) ** (1 / KAPPA);
}

/**
 * 伪绝热：给定当前 (T,p) 沿湿绝热积分到目标气压。
 * dT/dp 取 Emanuel (1994) 伪绝热形式（对水汽凝结潜热，不保留液态水）。
 */
export function moistAdiabatTemperatureC(
  tStartC: number,
  pStartHpa: number,
  pTargetHpa: number,
  stepHpa = 5,
): number {
  if (!(pStartHpa > 0) || !(pTargetHpa > 0)) return tStartC;
  if (Math.abs(pTargetHpa - pStartHpa) < 1e-6) return tStartC;

  const ascending = pTargetHpa < pStartHpa;
  const dp = ascending ? -Math.abs(stepHpa) : Math.abs(stepHpa);
  let p = pStartHpa;
  let tC = tStartC;

  while (ascending ? p > pTargetHpa : p < pTargetHpa) {
    const nextP = ascending
      ? Math.max(pTargetHpa, p + dp)
      : Math.min(pTargetHpa, p + dp);
    const midP = (p + nextP) / 2;
    const dT = moistDTdp(tC, midP) * (nextP - p);
    tC += dT;
    p = nextP;
  }
  return tC;
}

/** °C/hPa：伪绝热温度随气压变化率 */
function moistDTdp(tC: number, pHpa: number): number {
  const tK = tC + 273.15;
  const rS = saturationMixingRatio(tC, pHpa); // kg/kg
  const lv = LV0 - 2370 * tC; // 温度订正潜热
  // Γs (K/m) → dT/dp：静力 dp = −ρ g dz，ρ ≈ p/(Rd Tv)
  const numerator = RD * tK + lv * rS;
  const denominator =
    pHpa * (CPD + (lv * lv * rS * (EPS + rS)) / (RD * tK * tK));
  // p 以 hPa 计：RD*T 用 Pa 时需 ×100；此处统一把 p 当 hPa，
  // 分子 RD*T 对应 Pa 量纲 → dT/dp[K/hPa] = (RD*T+…)/(p_hPa*100*cp…) * 100
  // 简化后与 p 以 Pa 书写同形：dT/dp_hPa = numerator / (pHpa * cpd_term)
  return numerator / Math.max(denominator, 1e-6);
}

function interpolateHeight(levels: readonly ProfilePoint[], pHpa: number): number {
  if (levels.length === 0) return 0;
  const sorted = [...levels].sort((a, b) => b.pressure - a.pressure);
  if (pHpa >= sorted[0].pressure) return sorted[0].heightM;
  if (pHpa <= sorted[sorted.length - 1].pressure) {
    return sorted[sorted.length - 1].heightM;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pHpa <= a.pressure && pHpa >= b.pressure) {
      const lnA = Math.log(a.pressure);
      const lnB = Math.log(b.pressure);
      const t = (Math.log(pHpa) - lnA) / (lnB - lnA);
      return a.heightM + (b.heightM - a.heightM) * t;
    }
  }
  return sorted[0].heightM;
}

function envTemperatureC(levels: readonly ProfilePoint[], pHpa: number): number {
  const sorted = [...levels].sort((a, b) => b.pressure - a.pressure);
  if (pHpa >= sorted[0].pressure) return sorted[0].temperature;
  if (pHpa <= sorted[sorted.length - 1].pressure) {
    return sorted[sorted.length - 1].temperature;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pHpa <= a.pressure && pHpa >= b.pressure) {
      const lnA = Math.log(a.pressure);
      const lnB = Math.log(b.pressure);
      const t = (Math.log(pHpa) - lnA) / (lnB - lnA);
      return a.temperature + (b.temperature - a.temperature) * t;
    }
  }
  return sorted[0].temperature;
}

function envRh(levels: readonly ProfilePoint[], pHpa: number): number {
  const sorted = [...levels].sort((a, b) => b.pressure - a.pressure);
  if (pHpa >= sorted[0].pressure) return sorted[0].rh;
  if (pHpa <= sorted[sorted.length - 1].pressure) {
    return sorted[sorted.length - 1].rh;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (pHpa <= a.pressure && pHpa >= b.pressure) {
      const lnA = Math.log(a.pressure);
      const lnB = Math.log(b.pressure);
      const t = (Math.log(pHpa) - lnA) / (lnB - lnA);
      return a.rh + (b.rh - a.rh) * t;
    }
  }
  return sorted[0].rh;
}

/** 气块路径：地面 → 干绝热至 LCL → 湿绝热至廓线顶 */
export function parcelPath(levels: readonly ProfilePoint[]): ParcelPoint[] {
  if (levels.length < 2) return [];
  const sorted = [...levels].sort((a, b) => b.pressure - a.pressure);
  const sfc = sorted[0];
  const tdC = dewPointFromRh(sfc.temperature, sfc.rh);
  const pLcl = lclPressureHpa(sfc.temperature, tdC, sfc.pressure);
  const tLclC = lclTemperatureK(sfc.temperature + 273.15, tdC + 273.15) - 273.15;
  const theta = potentialTemperatureK(sfc.temperature, sfc.pressure);

  const path: ParcelPoint[] = [];
  const pTop = sorted[sorted.length - 1].pressure;
  // 沿气压均匀取样，保证曲线光滑
  const steps = 48;
  for (let i = 0; i <= steps; i += 1) {
    const lnP =
      Math.log(sfc.pressure) +
      (Math.log(pTop) - Math.log(sfc.pressure)) * (i / steps);
    const p = Math.exp(lnP);
    let tC: number;
    let stage: 'dry' | 'moist';
    if (p >= pLcl) {
      tC = dryAdiabatTemperatureC(theta, p);
      stage = 'dry';
    } else {
      tC = moistAdiabatTemperatureC(tLclC, pLcl, p);
      stage = 'moist';
    }
    path.push({
      pressure: p,
      temperature: tC,
      heightM: interpolateHeight(sorted, p),
      stage,
    });
  }
  // 保证 LCL 点落在路径上（插值可能略偏）
  path.push({
    pressure: pLcl,
    temperature: tLclC,
    heightM: interpolateHeight(sorted, pLcl),
    stage: 'dry',
  });
  path.sort((a, b) => b.pressure - a.pressure);
  return path;
}

/**
 * 标准伪绝热地面气块指数。返回值均保留一位小数。
 * 无有效廓线时返回全 0。
 */
export function computeSoundingIndices(levels: readonly ProfilePoint[]): SoundingIndices {
  if (levels.length < 2) {
    return { cape: 0, cin: 0, lclM: 0, li: 0, pw: 0 };
  }

  const sorted = [...levels].sort((a, b) => b.pressure - a.pressure);
  const sfc = sorted[0];
  const tdC = dewPointFromRh(sfc.temperature, sfc.rh);
  const pLcl = lclPressureHpa(sfc.temperature, tdC, sfc.pressure);
  const tLclC = lclTemperatureK(sfc.temperature + 273.15, tdC + 273.15) - 273.15;
  const theta = potentialTemperatureK(sfc.temperature, sfc.pressure);
  const lclHeight = interpolateHeight(sorted, pLcl);
  const lclM = Math.max(0, lclHeight - sfc.heightM);

  const pTop = sorted[sorted.length - 1].pressure;
  const pBot = sfc.pressure;

  // 细网格积分（hPa）；浮力 B = Tv,p − Tv,e（K）
  const dp = 5;
  type Sample = { p: number; buoy: number };
  const samples: Sample[] = [];
  const rSfc = mixingRatioFromRh(sfc.temperature, sfc.rh, sfc.pressure);

  for (let p = pBot; p >= pTop - 0.5; p -= dp) {
    const pClamped = Math.max(p, pTop);
    let tParcel: number;
    let rParcel: number;
    if (pClamped >= pLcl) {
      tParcel = dryAdiabatTemperatureC(theta, pClamped);
      rParcel = rSfc; // 干绝热段混合比守恒
    } else {
      tParcel = moistAdiabatTemperatureC(tLclC, pLcl, pClamped);
      rParcel = saturationMixingRatio(tParcel, pClamped);
    }
    const tEnv = envTemperatureC(sorted, pClamped);
    const rEnv = mixingRatioFromRh(tEnv, envRh(sorted, pClamped), pClamped);
    const tvP = virtualTemperatureK(tParcel, rParcel);
    const tvE = virtualTemperatureK(tEnv, rEnv);
    samples.push({ p: pClamped, buoy: tvP - tvE });
    if (pClamped <= pTop) break;
  }

  /**
   * LFC = 自地面向上首次由负（或零）转为持续正浮力的高度；
   * EL  = LFC 之上首次回到负浮力。
   * CAPE = Rd ∫_LFC^EL B dlnp；CIN = Rd ∫_SFC^LFC min(B,0) dlnp。
   */
  let lfcIndex = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].buoy > 0.05) {
      // 要求之上仍有一段正浮力，避免噪声误触发
      let positiveRun = 0;
      for (let j = i; j < Math.min(samples.length, i + 6); j += 1) {
        if (samples[j].buoy > 0) positiveRun += 1;
      }
      if (positiveRun >= 3) {
        lfcIndex = i;
        break;
      }
    }
  }

  let elIndex = samples.length - 1;
  if (lfcIndex >= 0) {
    for (let i = lfcIndex + 1; i < samples.length; i += 1) {
      if (samples[i].buoy < 0) {
        elIndex = i;
        break;
      }
    }
  }

  let cape = 0;
  let cin = 0;
  // 无 LFC 时 CAPE=0、CIN=0（与 MetPy 等工具一致，避免把整柱负浮力记成巨大 CIN）
  if (lfcIndex >= 0) {
    for (let i = 0; i < samples.length - 1; i += 1) {
      const a = samples[i];
      const b = samples[i + 1];
      const dLnP = Math.log(a.p) - Math.log(b.p);
      if (dLnP <= 0) continue;
      const meanBuoy = (a.buoy + b.buoy) / 2;
      const contrib = RD * meanBuoy * dLnP;

      if (i < lfcIndex) {
        if (meanBuoy < 0) cin += contrib;
      } else if (i < elIndex) {
        if (meanBuoy > 0) cape += contrib;
      }
    }
  }

  // LI：500 hPa
  const pLi = 500;
  let tParcel500: number;
  if (pLi >= pLcl) {
    tParcel500 = dryAdiabatTemperatureC(theta, pLi);
  } else {
    tParcel500 = moistAdiabatTemperatureC(tLclC, pLcl, pLi);
  }
  const tEnv500 = envTemperatureC(sorted, pLi);
  const li = tEnv500 - tParcel500;

  // PW：∫ q dp / g ；dp 以 Pa
  let pwPa = 0;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const qA = mixingRatioFromRh(a.temperature, a.rh, a.pressure);
    const qB = mixingRatioFromRh(b.temperature, b.rh, b.pressure);
    const qMean = (qA + qB) / 2;
    const dpPa = (a.pressure - b.pressure) * 100;
    if (dpPa > 0) pwPa += qMean * dpPa;
  }
  const pw = pwPa / G; // kg/m² ≈ mm

  return {
    cape: round1(Math.max(0, cape)),
    cin: round1(Math.min(0, cin)),
    lclM: round1(lclM),
    li: round1(li),
    pw: round1(Math.max(0, pw)),
  };
}

/**
 * 等饱和混合比线：给定 w (g/kg) 与 p → 饱和温度 °C（Newton 迭代）。
 */
export function temperatureAtMixingRatio(wGkg: number, pHpa: number): number | null {
  const w = wGkg / 1000;
  if (w <= 0 || pHpa <= 0) return null;
  // e = w*p / (ε+w)
  const e = (w * pHpa) / (EPS + w);
  if (e <= 0 || e >= pHpa) return null;
  // 反解 Magnus
  const ln = Math.log(e / 6.112);
  const tC = (243.12 * ln) / (17.62 - ln);
  if (!Number.isFinite(tC)) return null;
  return tC;
}
