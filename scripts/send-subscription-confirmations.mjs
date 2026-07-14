import { SITE_DOMAIN, EMAIL_THEME, createTransporter, maskEmail, renderEmailCard } from './lib/mail-theme.mjs';

const dryRun = process.argv.slice(2).includes('--dry-run');

const workerUrl = process.env.WORKER_URL;
const syncSecret = process.env.SYNC_SECRET;
if (!workerUrl || !syncSecret) {
  console.error('Missing required env var(s): WORKER_URL, SYNC_SECRET');
  process.exit(1);
}

async function fetchPending() {
  const res = await fetch(new URL('/pending', workerUrl), {
    headers: { Authorization: `Bearer ${syncSecret}` },
  });
  if (!res.ok) throw new Error(`Worker /pending returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.pending) ? data.pending : [];
}

async function markEmailed(tokens) {
  if (tokens.length === 0) return;
  const res = await fetch(new URL('/mark-emailed', workerUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncSecret}` },
    body: JSON.stringify({ tokens }),
  });
  if (!res.ok) {
    console.error(`Worker /mark-emailed returned ${res.status}; these entries may be re-emailed next run.`);
  }
}

function confirmationEmail({ email, token }, from, replyTo) {
  const confirmUrl = new URL('/confirm', workerUrl);
  confirmUrl.searchParams.set('token', token);

  return {
    from,
    to: email,
    replyTo,
    subject: 'Confirm your subscription',
    text: [
      `Someone (hopefully you) asked to subscribe this address to new posts on ${SITE_DOMAIN}.`,
      '',
      `Confirm here: ${confirmUrl}`,
      '',
      "If this wasn't you, ignore this email — nothing is added until the link above is clicked.",
    ].join('\n'),
    html: renderEmailCard({
      eyebrow: '03 / writing · confirm subscription',
      title: 'Confirm your subscription',
      bodyHtml: `<p style="margin:0;font-family:${EMAIL_THEME.fontBody};font-size:15px;line-height:1.6;color:${EMAIL_THEME.textDim};">Someone (hopefully you) asked to subscribe this address to new posts on ${SITE_DOMAIN}. Nothing is added to the list until you confirm below.</p>`,
      cta: { href: confirmUrl.toString(), label: 'Confirm subscription →' },
      footerHtml: "if this wasn't you, ignore this email — nothing is added without the link above",
    }),
  };
}

const pending = await fetchPending();

if (pending.length === 0) {
  console.log('No pending subscription confirmations to send.');
  process.exit(0);
}

console.log(
  `Found ${pending.length} pending confirmation(s): ${pending.map((p) => maskEmail(p.email)).join(', ')}`
);

if (dryRun) {
  console.log(`Dry run: would send ${pending.length} confirmation email(s).`);
  process.exit(0);
}

const from = process.env.MAIL_FROM;
const replyTo = process.env.MAIL_REPLY_TO || undefined;
const transporter = createTransporter();
await transporter.verify();

const sentTokens = [];
let anyFailed = false;

for (const entry of pending) {
  try {
    const info = await transporter.sendMail(confirmationEmail(entry, from, replyTo));
    const rejected = info.rejected?.filter(Boolean) ?? [];
    if (rejected.length > 0) {
      anyFailed = true;
      console.error(`SMTP server rejected ${maskEmail(entry.email)}.`);
      continue;
    }
    console.log(`Sent confirmation to ${maskEmail(entry.email)}.`);
    sentTokens.push(entry.token);
  } catch (err) {
    anyFailed = true;
    console.error(`Failed to send confirmation to ${maskEmail(entry.email)}: ${err.message}`);
  }
}

await markEmailed(sentTokens);

if (anyFailed) {
  console.error('One or more confirmation emails failed to send; unsent entries will be retried next run.');
  process.exit(1);
}
