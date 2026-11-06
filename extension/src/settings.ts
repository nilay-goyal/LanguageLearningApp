/** chrome.storage.local key: whether the extension is switched on. Missing means on. */
export const ENABLED_KEY = 'enabled';

export const isEnabledValue = (value: unknown) => value !== false;
