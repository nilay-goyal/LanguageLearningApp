// Shows the on/off state, and makes the translation requests: the page itself can't
// reach the API, and the client token stays out of Netflix's page.
import type { OverBudgetResponse, TranslateRequest, TranslateResponse } from '../../shared/protocol';
import type { TranslateOutcome } from '../src/learning/session';
import { API_OVERRIDE_KEY, ENABLED_KEY, isEnabledValue, TRANSLATE_MESSAGE } from '../src/settings';

const REQUEST_TIMEOUT_MS = 120_000;

const showState = (enabled: boolean) => browser.action.setBadgeText({ text: enabled ? '' : 'OFF' });

async function apiConfig(): Promise<{ url: string; token: string } | null> {
  if (import.meta.env.DEV) {
    const stored = await browser.storage.local.get(API_OVERRIDE_KEY);
    const override = stored[API_OVERRIDE_KEY] as { url: string; token: string } | undefined;
    if (override) return override;
  }
  const url = import.meta.env.WXT_API_URL as string | undefined;
  const token = import.meta.env.WXT_API_TOKEN as string | undefined;
  return url && token ? { url, token } : null;
}

async function translate(request: TranslateRequest): Promise<TranslateOutcome> {
  const config = await apiConfig();
  if (!config) return { ok: false, reason: 'unconfigured' };
  try {
    const response = await fetch(`${config.url}/v1/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, response: (await response.json()) as TranslateResponse };
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as OverBudgetResponse | null;
      if (body?.error === 'over_budget') return { ok: false, reason: 'over_budget' };
    }
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: { type?: string; request?: TranslateRequest }, _sender, sendResponse) => {
    if (message?.type !== TRANSLATE_MESSAGE || !message.request) return undefined;
    void translate(message.request).then(sendResponse);
    return true;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[ENABLED_KEY];
    if (area === 'local' && change) void showState(isEnabledValue(change.newValue));
  });

  void browser.storage.local.get(ENABLED_KEY).then((stored) => showState(isEnabledValue(stored[ENABLED_KEY])));
});
