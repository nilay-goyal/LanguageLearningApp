// Connects the caption layer on Netflix to the on/off setting.
import { CaptionController } from '../src/netflix/controller';
import { ENABLED_KEY, isEnabledValue } from '../src/settings';

export default defineContentScript({
  matches: ['https://www.netflix.com/*'],
  runAt: 'document_start',
  async main() {
    const controller = new CaptionController();
    const apply = (value: unknown) => (isEnabledValue(value) ? controller.start() : controller.stop());

    browser.storage.onChanged.addListener((changes, area) => {
      const change = changes[ENABLED_KEY];
      if (area === 'local' && change) apply(change.newValue);
    });
    const stored = await browser.storage.local.get(ENABLED_KEY);
    apply(stored[ENABLED_KEY]);
  },
});
