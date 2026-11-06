// The privacy policy page, served at /privacy. Plain language, for the tester study.

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function privacyHtml(contact?: string): string {
  const reach = contact
    ? `email <a href="mailto:${escape(contact)}">${escape(contact)}</a>`
    : 'contact the person who gave you your invite code';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy: Subtitle Learning test</title>
<style>
  body { font: 17px/1.55 Georgia, serif; max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; color: #191816; background: #f3eee5; }
  h1 { font-size: 1.7rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  a { color: #24406b; } li { margin: .3rem 0; }
</style></head><body>
<h1>Privacy: Subtitle Learning test</h1>
<p>This is a small, invite-only test of a browser extension that turns some of the words in your Netflix subtitles into French, so you can learn French while you watch. This page says what the test collects. It is written for the people taking part, who must be 18 or older.</p>

<h2>What we collect</h2>
<ul>
  <li><b>How you use it:</b> minutes of use, how far along the course you are, how much French was shown, how often you hold E to see the English, and whether you paused or skipped back just after French appeared.</li>
  <li><b>Your answers:</b> the short "how was it?" ratings after an episode, and your answers to the recall checks (which French words you remembered).</li>
  <li><b>Technical problems:</b> error messages and counts, and the version of the extension.</li>
  <li><b>Reports:</b> if you press R on French you think is wrong, we save that French, the English subtitle line it came from, and the stage you were at. This is the only time any subtitle text is saved, and only for the line you reported.</li>
  <li><b>Speech speed:</b> a rough bucket (for example "about 120 to 150 words a minute") for each episode, never the show's name.</li>
</ul>

<h2>What we do not collect</h2>
<ul>
  <li>Your name, email address or IP address. We don't ask for them, and the invite code you were given is stored only as a one-way hash.</li>
  <li>What you watch: no show titles, no Netflix video IDs, no viewing history.</li>
  <li>Your Netflix account, password or payment details.</li>
  <li>Subtitle text, other than the reported lines described above.</li>
</ul>

<h2>How the translation works</h2>
<p>The English subtitle lines of what you watch are sent to our server, and from there to OpenAI, to be translated into French. OpenAI is bound by its own terms for how it handles that text. The French that comes back is saved against a fingerprint of each line, never the English itself, so the same line can be reused for the next viewer.</p>

<h2>Where it is kept, and for how long</h2>
<p>Data is stored with Cloudflare. Usage data and recall answers are kept for the length of the test and up to 90 days after it, then deleted. Reported lines are deleted once they have been reviewed.</p>

<h2>Your choices</h2>
<ul>
  <li><b>Delete everything:</b> choose "Delete my data" in the extension's panel. It erases your usage data, answers and reports from our server and switches your invite code off.</li>
  <li><b>Stop any time:</b> remove the extension. Nothing more is sent.</li>
  <li><b>Questions:</b> ${reach}.</li>
</ul>

<h2>Netflix</h2>
<p>This extension is not made or endorsed by Netflix. It changes how subtitles are shown on a page you are already watching; it doesn't copy or download video. Netflix's own terms of use still apply to your account.</p>

<p><small>Version 1 of this policy, for the test.</small></p>
</body></html>`;
}
