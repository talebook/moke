import {
  safeGetLocalStorageItem,
  safeRemoveLocalStorageItem,
  safeSetLocalStorageItem,
} from './browser-storage.ts';

export const PRIVACY_CONSENT_STORAGE_KEY = 'moke-privacy-consent';
export const PRIVACY_POLICY_VERSION = '2026-08-14';
export const PRIVACY_CONSENT_CHANGED_EVENT = 'moke:privacy-consent-changed';

function notifyPrivacyConsentChanged(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(PRIVACY_CONSENT_CHANGED_EVENT));
  }
}

export function hasAcceptedCurrentPrivacyPolicy(): boolean {
  return safeGetLocalStorageItem(PRIVACY_CONSENT_STORAGE_KEY) === PRIVACY_POLICY_VERSION;
}

export function acceptCurrentPrivacyPolicy(): void {
  safeSetLocalStorageItem(PRIVACY_CONSENT_STORAGE_KEY, PRIVACY_POLICY_VERSION);
  notifyPrivacyConsentChanged();
}

export function revokeCurrentPrivacyPolicy(): void {
  safeRemoveLocalStorageItem(PRIVACY_CONSENT_STORAGE_KEY);
  notifyPrivacyConsentChanged();
}
