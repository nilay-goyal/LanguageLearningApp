// Toolbar icon: click to switch the extension on or off. The real controls come later.
import { ENABLED_KEY, isEnabledValue } from '../src/settings';

const showState = (enabled: boolean) => browser.action.setBadgeText({ text: enabled ? '' : 'OFF' });

export default defineBackground(() => {
  browser.action.onClicked.addListener(async () => {
    const stored = await browser.storage.local.get(ENABLED_KEY);
    await browser.storage.local.set({ [ENABLED_KEY]: !isEnabledValue(stored[ENABLED_KEY]) });
  });

  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[ENABLED_KEY];
    if (area === 'local' && change) void showState(isEnabledValue(change.newValue));
  });

  void browser.storage.local.get(ENABLED_KEY).then((stored) => showState(isEnabledValue(stored[ENABLED_KEY])));
});
