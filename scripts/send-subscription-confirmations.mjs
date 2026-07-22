import { SITE_DOMAIN, EMAIL_THEME, createTransporter, maskEmail, renderEmailCard } from './lib/mail-theme.mjs';

export async function fetchPending(workerUrl, syncSecret) {
  const res = await fetch(new URL('/pending', workerUrl), {
    headers: { Authorization: `Bearer ${syncSecret}` },
  });
  if (!res.ok) throw new Error(`Worker /pending returned ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.pending) ? data.pending : [];
}

export async function markEmailed(workerUrl, syncSecret, tokens) {
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

export function confirmationEmail({ email, token }, { workerUrl, from, replyTo, logoSrc, attachments }) {
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
      logoSrc,
    }),
    attachments,
  };
}

// Core send loop, independent of process.argv/process.exit so it can be
// exercised in tests. Returns a summary instead of exiting — the CLI
// entrypoint below decides what that means for the process exit code.
export async function run({
  dryRun = process.argv.slice(2).includes('--dry-run'),
  workerUrl = process.env.WORKER_URL,
  syncSecret = process.env.SYNC_SECRET,
  from = process.env.MAIL_FROM,
  replyTo = process.env.MAIL_REPLY_TO || undefined,
  transporterFactory = createTransporter,
} = {}) {
  if (!workerUrl || !syncSecret) {
    throw new Error('Missing required env var(s): WORKER_URL, SYNC_SECRET');
  }

  const pending = await fetchPending(workerUrl, syncSecret);

  if (pending.length === 0) {
    console.log('No pending subscription confirmations to send.');
    return { pendingCount: 0, sent: [], failed: [] };
  }

  console.log(
    `Found ${pending.length} pending confirmation(s): ${pending.map((p) => maskEmail(p.email)).join(', ')}`
  );

  if (dryRun) {
    console.log(`Dry run: would send ${pending.length} confirmation email(s).`);
    return { pendingCount: pending.length, sent: [], failed: [], dryRun: true };
  }

  const transporter = transporterFactory();
  await transporter.verify();

  const sentTokens = [];
  const failed = [];

  for (const entry of pending) {
    try {
      const info = await transporter.sendMail(confirmationEmail(entry, { workerUrl, from, replyTo }));
      const rejected = info.rejected?.filter(Boolean) ?? [];
      if (rejected.length > 0) {
        failed.push(entry);
        console.error(`SMTP server rejected ${maskEmail(entry.email)}.`);
        continue;
      }
      console.log(`Sent confirmation to ${maskEmail(entry.email)}.`);
      sentTokens.push(entry.token);
    } catch (err) {
      failed.push(entry);
      console.error(`Failed to send confirmation to ${maskEmail(entry.email)}: ${err.message}`);
    }
  }

  await markEmailed(workerUrl, syncSecret, sentTokens);

  return { pendingCount: pending.length, sent: sentTokens, failed };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const result = await run();
    if (result.failed.length > 0) {
      console.error('One or more confirmation emails failed to send; unsent entries will be retried next run.');
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
