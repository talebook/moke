import {
  safeGetLocalStorageItem,
  safeSetLocalStorageItem,
} from './browser-storage.ts';

export const PRIVACY_CONSENT_STORAGE_KEY = 'moke-privacy-consent';
export const PRIVACY_POLICY_VERSION = '2026-08-14';

export function hasAcceptedCurrentPrivacyPolicy(): boolean {
  return safeGetLocalStorageItem(PRIVACY_CONSENT_STORAGE_KEY) === PRIVACY_POLICY_VERSION;
}

export function acceptCurrentPrivacyPolicy(): void {
  safeSetLocalStorageItem(PRIVACY_CONSENT_STORAGE_KEY, PRIVACY_POLICY_VERSION);
}
