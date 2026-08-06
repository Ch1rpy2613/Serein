import type { City } from '../contracts';
import type { AudioPrefs } from '../audio';
import type { PushAlertLevel } from '../push/subscribe';
import type { Quality } from '../perf';

/** 跨设备同步 payload（服务端不解析字段；仅前端约定） */
export type SyncPayload = {
  savedCities: City[];
  currentCity: City;
  dismissedAlertIds: string[];
  audioPrefs: AudioPrefs;
  qualityOverride: Quality | null;
  pushLevels: PushAlertLevel[];
};

export type SyncGetResponse = {
  payload: SyncPayload;
  version: number;
};

export type SyncCreateResponse = {
  code: string;
  version: number;
};

export type SyncPutResponse = {
  version: number;
};

export type SyncConflict = {
  kind: 'conflict';
  version: number;
};

export type SyncNotFound = {
  kind: 'not_found';
};

export type SyncHttpError = {
  kind: 'error';
  status: number;
  message: string;
};
