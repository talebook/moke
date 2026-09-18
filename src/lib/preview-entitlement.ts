export type PreviewEntitlementState =
  | 'notConfigured'
  | 'inactive'
  | 'active'
  | 'offlineGrace'
  | 'expired'
  | 'clockRollback'
  | 'invalid';

export interface PreviewEntitlementStatus {
  state: PreviewEntitlementState;
  serviceConfigured: boolean;
  deviceId: string;
  subject: string | null;
  capabilities: string[];
  expiresAt: number | null;
  offlineUntil: number | null;
  message: string;
}

export interface NativeBuildInfo {
  channel: 'stable' | 'preview';
  previewCompiled: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function assertPreviewNativeBuild(info: NativeBuildInfo): void {
  if (info.channel !== 'preview' || !info.previewCompiled) {
    throw new Error('Preview 前端与原生构建通道不一致，应用已安全锁定。');
  }
}

export function effectiveEntitlementState(
  status: PreviewEntitlementStatus,
  nowMs: number = Date.now(),
): PreviewEntitlementState {
  const now = Math.floor(nowMs / 1000);
  if (status.state !== 'active' && status.state !== 'offlineGrace') return status.state;
  if (status.expiresAt === null || status.offlineUntil === null) return 'invalid';
  if (now > status.offlineUntil) return 'expired';
  if (status.state === 'offlineGrace') return 'offlineGrace';
  if (now > status.expiresAt) return 'offlineGrace';
  return 'active';
}

export function nextEntitlementBoundaryDelay(
  status: PreviewEntitlementStatus,
  nowMs: number = Date.now(),
): number | null {
  const state = effectiveEntitlementState(status, nowMs);
  const boundary = state === 'active'
    ? status.expiresAt
    : state === 'offlineGrace'
      ? status.offlineUntil
      : null;
  if (boundary === null) return null;

  const delay = ((boundary + 1) * 1000) - nowMs;
  return Math.max(0, Math.min(delay, MAX_TIMER_DELAY_MS));
}
