/**
 * Köppen 分类码 → 中文名（常见码齐全；缺省只显码）。
 * 参考 Beck et al. / Peel 标准字母含义。
 */

/** 主气候型 + 常见亚型 */
export const KOPPEN_ZH: Readonly<Record<string, string>> = {
  Af: '热带雨林气候',
  Am: '热带季风气候',
  Aw: '热带疏林草原气候',
  As: '热带干旱草原气候',
  BWh: '热带沙漠气候',
  BWk: '温带沙漠气候',
  BSh: '热带半干旱气候',
  BSk: '温带半干旱气候',
  Csa: '地中海气候',
  Csb: '温和地中海气候',
  Csc: '寒地中海气候',
  Cwa: '亚热带季风气候',
  Cwb: '高原亚热带气候',
  Cwc: '高寒亚热带气候',
  Cfa: '亚热带湿润气候',
  Cfb: '温带海洋性气候',
  Cfc: '亚极地海洋性气候',
  Dsa: '温带大陆性夏干气候',
  Dsb: '寒温带夏干气候',
  Dsc: '亚极地夏干气候',
  Dsd: '极地夏干气候',
  Dwa: '温带季风气候',
  Dwb: '寒温带季风气候',
  Dwc: '亚极地季风气候',
  Dwd: '极地季风气候',
  Dfa: '温带大陆性湿润气候',
  Dfb: '寒温带湿润气候',
  Dfc: '亚极地气候',
  Dfd: '极地大陆气候',
  ET: '苔原气候',
  EF: '冰原气候',
};

/** 格式：`Dwa · 温带季风气候`；未知码只返回码本身 */
export function formatKoppenLabel(code: string | null | undefined): string {
  if (!code) return '';
  const zh = KOPPEN_ZH[code];
  return zh ? `${code} · ${zh}` : code;
}
