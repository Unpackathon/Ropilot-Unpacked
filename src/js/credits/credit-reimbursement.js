let pending = null;
let active = null;
let retryTimer = null;
const seenThisSession = new Set();
export function validNotice(value) {
  return !!value && typeof value.id === 'string' && /^(cache-loss-20260918|apply-patch-thrash-20260923|opus55-billing-20260923|cache-miss-astra-20260926|support-refunds-20260928):[a-f0-9]{32}$/.test(value.id)
    && typeof value.credits === 'number' && Number.isFinite(value.credits) && value.credits > 0 && value.credits <= 500;
}
function seen(id) {
  try { return seenThisSession.has(id) || localStorage.getItem(`ropilot_reimbursement_seen:${id}`) === 'true'; }
  catch { return seenThisSession.has(id); }
}
function tryShow() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (!pending || active) return;
  const { notice, stillCurrent } = pending;
  if (!stillCurrent() || seen(notice.id)) { pending = null; return; }
  // Wait for onboarding/other announcements or an active generation to finish.
  if (document.querySelector('dialog[open], .modal:not(.hidden), .setup-screen:not(.hidden), .status-bar:not(.hidden)')) {
    retryTimer = setTimeout(tryShow, 2000);
    return;
  }
  const template = document.getElementById('credit-reimbursement-template');
  if (!template) { pending = null; return; }
  const fragment = template.content.cloneNode(true);
  const dialog = fragment.querySelector('dialog');
  dialog.querySelector('[data-reimbursement-amount]').textContent = notice.credits.toFixed(2);
  pending = null;
  active = dialog;
  let accountWatch;
  dialog.addEventListener('close', () => {
    clearInterval(accountWatch);
    if (stillCurrent()) {
      seenThisSession.add(notice.id);
      try { localStorage.setItem(`ropilot_reimbursement_seen:${notice.id}`, 'true'); } catch {}
    }
    dialog.remove(); active = null; tryShow();
  }, { once: true });
  document.body.appendChild(fragment);
  dialog.showModal();
  // Never leave a previous account's amount onscreen after an account switch.
  accountWatch = setInterval(() => { if (!stillCurrent()) dialog.close(); }, 500);
}
export function showCreditReimbursement(notice, stillCurrent) {
  if (!validNotice(notice) || seen(notice.id) || active) return;
  pending = { notice, stillCurrent };
  tryShow();
}
