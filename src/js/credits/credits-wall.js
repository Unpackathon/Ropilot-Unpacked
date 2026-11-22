// @ts-check
// Credits wall: the inline out-of-credits card (no-actions "modal"), its
// credit-recovery watcher and auto-resume flow, auto top-up (auto-refill)
// state + one-tap refill, and wall telemetry. Extracted from app.js; holds
// the app reference and reaches back through it for balance state, the
// recovery flags (written externally by message-renderer), and the
// Ropilot-Credits retry/upgrade policy helpers that stay on the app.
import { escapeHtml } from '../utils.js';
import { electronAPI } from '../core/platform.js';
import { siteUrlFromConfig } from '../core/urls.js';

// Auto-resume guards for the managed Ropilot-Credits wall: at most this many
// automatic resumes per wall episode (same chat + same last user message),
// spaced at least this far apart. Manual "Resume now" is never gated.
const NO_ACTIONS_AUTO_RESUME_MAX_ATTEMPTS = 2;
const NO_ACTIONS_AUTO_RESUME_MIN_SPACING_MS = 15000;

// Shared by the live wall (createNoActionsCard) and the stored-chat fallback
// card in message-renderer.js — settings.js hydrates every [data-cic-invite].
export const INLINE_INVITE_PROMO_MARKUP = `
  <div class="cic-invite hidden" data-cic-invite>
    <svg class="cic-invite-gift" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="20 12 20 22 4 22 4 12"></polyline>
      <rect x="2" y="7" width="20" height="5"></rect>
      <line x1="12" y1="22" x2="12" y2="7"></line>
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"></path>
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"></path>
    </svg>
    <div class="cic-invite-text">
      <span class="cic-invite-title">Invite friends</span>
      <span class="cic-invite-sub" data-cic-invite-sub></span>
    </div>
    <span class="cic-invite-badge" data-cic-invite-badge>0 / 3</span>
    <button type="button" class="cic-invite-copy" data-cic-invite-copy>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span data-cic-invite-copy-label>Copy link</span>
    </button>
  </div>
`;

export class CreditsWall {
  constructor(app) {
    this.app = app;
    // Re-render the wall card whenever the credits-session state changes.
    // Mirrors the old manual flow where settings.js mutated
    // app.actionsRemaining and then invoked handleAccountBalanceUpdated →
    // updateNoActionsCard; updateNoActionsCard no-ops when no card is shown.
    this.app.store?.subscribe('credits', () => this.updateNoActionsCard());
  }

  // Out-of-credits prompt — rendered inline in the chat (not a popup)
  showNoActionsModal(options = {}) {
    const container = document.getElementById('messages');
    if (!container) return;
    if (options?.upgradeToRopilotCreditsOnPurchase === true) {
      this.app.noActionsUpgradeToRopilotCreditsPending = true;
      this.app.noActionsChatGptUsageLimitRetryAt = String(options?.chatGptUsageLimitRetryAt || '').trim();
    } else if (!options?.source && this.isNoActionsWallDismissedForCurrentTurn()) {
      // "Maybe later" (or Stop) dismissed the managed wall for this turn —
      // don't re-show it for the same failure. The memory expires on the
      // next user-initiated send (the turn key changes).
      return;
    }
    this.ensureNoActionsWallEpisode();
    if (document.getElementById('credits-inline-card')) {
      this.updateNoActionsCard();
      this.startNoActionsCreditRecoveryWatcher();
      return;
    }
    container.appendChild(this.createNoActionsCard());
    this.startNoActionsCreditRecoveryWatcher();
    const scroller = document.getElementById('chat-messages-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  hideNoActionsModal() {
    this.app.noActionsAutoRetryInFlight = false;
    this.app.noActionsUpgradeToRopilotCreditsPending = false;
    this.app.noActionsChatGptUsageLimitRetryAt = '';
    this.stopNoActionsCreditRecoveryWatcher();
    document.getElementById('credits-inline-card')?.remove();
  }

  clearNoActionsUpgradeRecoveryState() {
    this.app.noActionsAutoRetryInFlight = false;
    this.app.noActionsUpgradeToRopilotCreditsPending = false;
    this.app.noActionsChatGptUsageLimitRetryAt = '';
    this.stopNoActionsCreditRecoveryWatcher();
  }

  getNoActionsMinimumCredits() {
    return 0.2;
  }

  /**
   * Identity of the failure the wall is about: same chat + same last user
   * message. A user-initiated send appends a user timeline entry and changes
   * the key; the resume path re-sends with skipAddMessage=true, so resume
   * cycles stay inside one episode (the attempt cap and dismissal memory
   * survive the wall being hidden/re-shown by the retry loop).
   */
  getNoActionsWallTurnKey() {
    const chat = this.app.activeChat;
    if (!chat?.id) return '';
    const timeline = Array.isArray(chat.timeline) ? chat.timeline : [];
    let userMessageCount = 0;
    let lastUserItemId = '';
    for (const item of timeline) {
      if (item?.type === 'user') {
        userMessageCount += 1;
        if (item.id != null && item.id !== '') lastUserItemId = String(item.id);
      }
    }
    // The count alone is not identity: rewind ("Delete messages after this
    // point") truncates the timeline, so a later unrelated turn can land on
    // the same count and inherit a stale dismissal/episode. Anchor the key
    // to the last user item's id when it has one (addToTimeline assigns
    // ids); the bare count stays as fallback for legacy items without ids.
    return lastUserItemId
      ? `${chat.id}:${userMessageCount}:${lastUserItemId}`
      : `${chat.id}:${userMessageCount}`;
  }

  isNoActionsWallDismissedForCurrentTurn() {
    const key = this.getNoActionsWallTurnKey();
    return !!key && this.app.noActionsWallDismissedKey === key;
  }

  // Reset the auto-resume guards when the wall starts covering a NEW
  // failure; keep them when the same episode's wall is merely re-shown.
  ensureNoActionsWallEpisode() {
    const key = this.getNoActionsWallTurnKey();
    if (this.app.noActionsWallEpisodeKey === key) return;
    this.app.noActionsWallEpisodeKey = key;
    this.app.noActionsAutoResumeAttempts = 0;
    this.app.noActionsLastAutoResumeAt = 0;
    this.app.noActionsAutoResumeCapReached = false;
    // Auto-resume requires the balance to INCREASE past this baseline
    // (null when the balance is unknown at show time — the first observed
    // reading is adopted as the baseline instead).
    this.app.noActionsWallShownBalance = this.getManagedCreditsRemaining();
  }

  /**
   * A user Stop while the managed wall is visible is a dismissal of the
   * auto-resume flow: halt the watcher and remember the episode so a
   * balance update can't silently re-send the prompt (it used to just
   * unblock the next watcher tick). The card stays with manual "Resume
   * now"; the memory expires on the next user-initiated send.
   */
  handleUserStop() {
    if (!document.getElementById('credits-inline-card')) return;
    if (this.app.noActionsUpgradeToRopilotCreditsPending === true) return;
    this.app.noActionsWallDismissedKey = this.getNoActionsWallTurnKey();
    this.stopNoActionsCreditRecoveryWatcher();
    this.updateNoActionsCard();
  }

  isLocalServerWebSocketOpen() {
    return this.app.ws && this.app.ws.readyState === WebSocket.OPEN;
  }

  getManagedCreditsRemaining() {
    const balance = this.app.accountCreditsBalance;
    const isManagedBalance = balance?.type === 'managed_ai_credits'
      || balance?.balance_type === 'managed_ai_credits';
    if (isManagedBalance && Number.isFinite(Number(balance.remaining))) {
      return Number(balance.remaining);
    }

    const latestManaged = this.app.latestManagedAiCreditsBalance;
    if (latestManaged && Number.isFinite(Number(latestManaged.remaining))) {
      return Number(latestManaged.remaining);
    }

    const payload = this.app.latestAccountBalancePayload || {};
    const managed = payload.managed_ai_credits && typeof payload.managed_ai_credits === 'object'
      ? payload.managed_ai_credits
      : null;
    const account = payload.account_credits && typeof payload.account_credits === 'object'
      ? payload.account_credits
      : null;
    const source = managed || (account?.balance_type === 'managed_ai_credits' ? account : null);
    const raw = source?.credits_remaining ?? source?.remaining;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  getNoActionsKickerText() {
    if (this.app.noActionsUpgradeToRopilotCreditsPending === true) {
      const retryAt = String(this.app.noActionsChatGptUsageLimitRetryAt || '').trim();
      if (retryAt) {
        return `You have hit your ChatGPT usage limit. Try again at ${retryAt}. Here's how to keep going:`;
      }
      return 'You have hit your ChatGPT usage limit. Here\'s how to keep going:';
    }
    const base = "You're out of Ropilot Credits. Here's how to keep going:";
    const remaining = this.getManagedCreditsRemaining();
    if (remaining === null || remaining >= this.getNoActionsMinimumCredits()) {
      return base;
    }
    const roundedToCents = Math.round((remaining + Number.EPSILON) * 100) / 100;
    if (roundedToCents <= 0) {
      return base;
    }
    return `You need at least ${this.getNoActionsMinimumCredits()} credits. ${base}`;
  }

  getNoActionsResumeStatusText() {
    const remaining = this.getManagedCreditsRemaining();
    if (this.app.noActionsAutoRetryInFlight) {
      return 'Credits found. Resuming this message...';
    }
    if (this.app.noActionsUpgradeToRopilotCreditsPending !== true) {
      if (this.app.noActionsAutoResumeCapReached === true) {
        return 'Automatic resume is paused after 2 attempts — click "Resume now" to retry.';
      }
      if (this.isNoActionsWallDismissedForCurrentTurn()) {
        return 'Automatic resume is off for this message. Click "Resume now" to retry.';
      }
    }
    if (remaining !== null && remaining >= this.getNoActionsMinimumCredits()) {
      // The managed auto-resume only fires when the balance INCREASES past
      // the wall-shown baseline (handleAccountBalanceUpdated) — only promise
      // it when that guard can actually pass. Otherwise the truthful
      // guidance is the manual path.
      const shownBalance = this.app.noActionsWallShownBalance;
      const willAutoResume = this.app.noActionsUpgradeToRopilotCreditsPending === true
        || (Number.isFinite(shownBalance) && remaining > shownBalance);
      if (willAutoResume) {
        return 'Credits are available. Resuming this message automatically...';
      }
      return 'Add credits to resume this message automatically, or click "Resume now" to retry.';
    }
    if (this.isLocalServerWebSocketOpen()) {
      return 'After you add credits, this message resumes automatically.';
    }
    return 'Reconnect Ropilot Studio to resume automatically after credits are added.';
  }

  updateNoActionsCard() {
    const card = document.getElementById('credits-inline-card');
    if (!card) return;
    const kicker = card.querySelector('.cic-kicker');
    if (kicker) {
      kicker.textContent = this.getNoActionsKickerText();
    }
    const resumeStatus = card.querySelector('.cic-resume-status');
    if (resumeStatus) {
      resumeStatus.textContent = this.getNoActionsResumeStatusText();
    }
    const retryButton = card.querySelector('#cic-resume-now');
    if (retryButton) {
      const hasEnoughCredits = (this.getManagedCreditsRemaining() ?? 0) >= this.getNoActionsMinimumCredits();
      retryButton.disabled = this.app.noActionsAutoRetryInFlight || !this.isLocalServerWebSocketOpen();
      retryButton.textContent = hasEnoughCredits ? 'Resume now' : 'Check credits';
    }
  }

  startNoActionsCreditRecoveryWatcher() {
    this.updateNoActionsCard();
    // Managed variant only: once auto-resume is capped or the user
    // dismissed/stopped this episode, the card is manual-only — don't spin
    // the 4s poller back up on re-show.
    if (this.app.noActionsUpgradeToRopilotCreditsPending !== true
      && (this.app.noActionsAutoResumeCapReached === true || this.isNoActionsWallDismissedForCurrentTurn())) {
      return;
    }
    if (this.app.noActionsCreditRefreshTimer) return;

    const tick = async () => {
      if (!document.getElementById('credits-inline-card')) {
        this.stopNoActionsCreditRecoveryWatcher();
        return;
      }

      this.updateNoActionsCard();
      if (!this.isLocalServerWebSocketOpen() || this.app.noActionsAutoRetryInFlight) {
        return;
      }

      const refresh = this.app.settings?.refreshManagedAiCredits?.();
      if (refresh && typeof refresh.catch === 'function') {
        refresh.catch((err) => {
          console.warn('Failed to refresh managed AI credits while waiting to resume:', err);
        });
      }
    };

    tick();
    this.app.noActionsCreditRefreshTimer = setInterval(tick, 4000);
  }

  stopNoActionsCreditRecoveryWatcher() {
    if (this.app.noActionsCreditRefreshTimer) {
      clearInterval(this.app.noActionsCreditRefreshTimer);
      this.app.noActionsCreditRefreshTimer = null;
    }
  }

  handleAccountBalanceUpdated(previousBalance, nextBalance) {
    this.updateNoActionsCard();
    if (!document.getElementById('credits-inline-card')) return;
    if (this.app.noActionsAutoRetryInFlight) return;

    const isManagedBalance = nextBalance?.type === 'managed_ai_credits'
      || nextBalance?.balance_type === 'managed_ai_credits';
    const remaining = Number(nextBalance?.remaining);
    if (!isManagedBalance || !Number.isFinite(remaining)) {
      return;
    }
    if (!Number.isFinite(this.app.noActionsWallShownBalance)) {
      // Balance was unknown when the wall appeared: adopt the FIRST observed
      // reading as the baseline and wait for a real increase. This must run
      // before the minimum-credits gate below — a genuine 0.0 reading has to
      // be able to seed the baseline, otherwise the first reading past the
      // minimum is the post-purchase balance itself and gets swallowed as
      // the baseline instead of resuming.
      this.app.noActionsWallShownBalance = remaining;
    }
    if (remaining < this.getNoActionsMinimumCredits()) {
      return;
    }
    if (!this.isLocalServerWebSocketOpen()) {
      return;
    }

    if (this.app.noActionsUpgradeToRopilotCreditsPending === true) {
      // ChatGPT usage-limit card on a bring-your-own account: resuming here
      // switches the whole account to Ropilot Credits, so it must be driven by
      // a purchase/top-up while the card is visible (balance increased) or the
      // explicit "Resume now" click — leftover credits alone must not silently
      // flip the account away from the user's subscription.
      const previousIsManaged = previousBalance?.type === 'managed_ai_credits'
        || previousBalance?.balance_type === 'managed_ai_credits';
      const previousRemaining = Number(previousBalance?.remaining);
      const balanceIncreased = previousIsManaged
        && Number.isFinite(previousRemaining)
        && remaining > previousRemaining;
      if (!balanceIncreased) {
        return;
      }
      this.retryNoActionsAfterCreditRecovery();
      return;
    }

    // Managed Ropilot-Credits card: auto-resume re-sends the full last
    // prompt, so a bad balance signal must never be able to loop it. It
    // requires (1) no dismissal/Stop for this episode, (2) the balance to
    // have INCREASED past what it was when the wall appeared (a real
    // purchase/top-up — mirrors the ChatGPT-variant guard above), and it
    // is capped and rate-limited in attemptNoActionsAutoResume. Manual
    // "Resume now" bypasses all of this.
    if (this.isNoActionsWallDismissedForCurrentTurn()) {
      return;
    }
    const shownBalance = this.app.noActionsWallShownBalance;
    if (!Number.isFinite(shownBalance) || remaining <= shownBalance) {
      return;
    }

    this.attemptNoActionsAutoResume();
  }

  // Cap + spacing wrapper for AUTOMATIC resumes of the managed wall (the
  // manual "Resume now" path calls retryNoActionsAfterCreditRecovery
  // directly and is never counted or blocked here).
  attemptNoActionsAutoResume() {
    const attempts = Number(this.app.noActionsAutoResumeAttempts) || 0;
    if (attempts >= NO_ACTIONS_AUTO_RESUME_MAX_ATTEMPTS) {
      // Cap hit: leave the card in manual-resume state and stop polling;
      // the status text explains that it will not auto-retry anymore.
      this.app.noActionsAutoResumeCapReached = true;
      this.stopNoActionsCreditRecoveryWatcher();
      this.updateNoActionsCard();
      return false;
    }
    const lastAttemptAt = Number(this.app.noActionsLastAutoResumeAt) || 0;
    if (lastAttemptAt && Date.now() - lastAttemptAt < NO_ACTIONS_AUTO_RESUME_MIN_SPACING_MS) {
      return false;
    }
    const sent = this.retryNoActionsAfterCreditRecovery();
    if (sent) {
      this.app.noActionsAutoResumeAttempts = attempts + 1;
      this.app.noActionsLastAutoResumeAt = Date.now();
      if (this.app.noActionsAutoResumeAttempts >= NO_ACTIONS_AUTO_RESUME_MAX_ATTEMPTS) {
        this.app.noActionsAutoResumeCapReached = true;
      }
    }
    return sent;
  }

  handleManagedAiCreditsBalanceUpdated(previousBalance, nextBalance) {
    this.updateNoActionsCard();
    if (this.app.isUseRopilotCreditsEnabled?.() === true) return;
    this.handleAccountBalanceUpdated(previousBalance, nextBalance);
  }

  async refreshAndMaybeResumeNoActions() {
    const refresh = this.app.settings?.refreshManagedAiCredits?.();
    if (refresh && typeof refresh.then === 'function') {
      try {
        await refresh;
      } catch (err) {
        console.warn('Failed to refresh managed AI credits before resume:', err);
      }
    }
    this.updateNoActionsCard();

    const remaining = this.getManagedCreditsRemaining();
    if (remaining !== null && remaining >= this.getNoActionsMinimumCredits()) {
      return this.retryNoActionsAfterCreditRecovery();
    }
    return false;
  }

  retryNoActionsAfterCreditRecovery() {
    if (this.app.noActionsAutoRetryInFlight) return false;
    if (!this.isLocalServerWebSocketOpen()) {
      this.updateNoActionsCard();
      return false;
    }

    const targetChat = this.app.activeChat;
    if (!targetChat || this.app.isChatProcessing(targetChat.id)) {
      this.updateNoActionsCard();
      return false;
    }

    this.app.noActionsAutoRetryInFlight = true;
    this.updateNoActionsCard();
    const shouldApplyCreditsUpgrade = this.app.noActionsUpgradeToRopilotCreditsPending === true;
    if (shouldApplyCreditsUpgrade) {
      this.app.applyRopilotCreditsPurchaseDefaults();
    }
    const routePriority = shouldApplyCreditsUpgrade
      ? 'economy'
      : (this.app.getRopilotCreditsRoutePriority?.() || 'priority');
    const sent = this.app.retryRopilotCreditsRouteFailure(routePriority);
    if (sent) {
      // A resume that actually went out starts a fresh attempt: forget any
      // dismissal/Stop memory so a follow-up failure can wall again.
      this.app.noActionsWallDismissedKey = '';
      this.hideNoActionsModal();
      return true;
    }

    this.app.noActionsAutoRetryInFlight = false;
    this.updateNoActionsCard();
    return false;
  }

  /**
   * Fire-and-forget credit-wall telemetry (wall_shown / dismissed /
   * checkout_opened) so modal CVR is measurable server-side. Must never
   * block or break the wall itself. 'shown' is throttled because the card
   * is also re-created when stored chats re-render.
   */
  postWallEvent(event, surface = 'no_actions') {
    try {
      if (event === 'shown') {
        const now = Date.now();
        if (this.app._lastWallShownPostAt && now - this.app._lastWallShownPostAt < 5 * 60 * 1000) return;
        this.app._lastWallShownPostAt = now;
      }
      const apiKey = typeof this.app.getEffectiveApiKey === 'function' ? this.app.getEffectiveApiKey() : this.app.apiKey;
      if (!apiKey) return;
      const siteUrl = siteUrlFromConfig(this.app.config);
      fetch(`${siteUrl}/api/analytics/wall-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ event, surface }),
      }).catch(() => {});
    } catch {
      // Telemetry only.
    }
  }

  /**
   * Auto top-up state for the credit wall (GET /api/auto-refill). Cached
   * briefly; the wall re-renders when it resolves. Fails silent — the wall
   * must never depend on it.
   */
  async fetchAutoRefillState() {
    try {
      const apiKey = typeof this.app.getEffectiveApiKey === 'function' ? this.app.getEffectiveApiKey() : this.app.apiKey;
      if (!apiKey) return null;
      const siteUrl = siteUrlFromConfig(this.app.config);
      const response = await fetch(`${siteUrl}/api/auto-refill`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return null;
      const body = await response.json();
      this.app._autoRefillState = body?.auto_refill || null;
      return this.app._autoRefillState;
    } catch {
      return null;
    }
  }

  /**
   * One-tap wall action for users with recorded consent + saved card:
   * charges the configured pack off-session and re-enables auto top-up.
   * The button label states the charge — that is the consent for it.
   */
  async refillNowAndEnable(statusEl) {
    try {
      const apiKey = typeof this.app.getEffectiveApiKey === 'function' ? this.app.getEffectiveApiKey() : this.app.apiKey;
      if (!apiKey) return;
      const siteUrl = siteUrlFromConfig(this.app.config);
      if (statusEl) statusEl.textContent = 'Charging your saved card…';
      const charge = await fetch(`${siteUrl}/api/auto-refill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ action: 'refill_now' }),
      });
      const chargeBody = await charge.json().catch(() => ({}));
      if (!charge.ok) {
        if (statusEl) statusEl.textContent = chargeBody?.checkout_required
          ? 'Card setup needed — finishing in checkout…'
          : 'Payment did not go through — opening checkout…';
        electronAPI()?.openExternal(`${siteUrl}/pricing?auto_refill=1`);
        return;
      }
      const enable = await fetch(`${siteUrl}/api/auto-refill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ action: 'enable' }),
      });
      const enableBody = await enable.json().catch(() => ({}));
      if (!enable.ok) {
        if (statusEl) statusEl.textContent = 'Credits were added, but auto top-up could not be turned on. Try again.';
        return;
      }
      const nextState = enableBody?.auto_refill;
      if (nextState) {
        this.app._autoRefillState = nextState;
        const card = statusEl?.closest?.('#credits-inline-card');
        if (card) {
          await this.renderWallAutoRefillSection(card, nextState);
          statusEl = card.querySelector('#cic-auto-status');
        }
        if (nextState.enabled !== true) {
          if (statusEl) statusEl.textContent = 'Credits were added, but auto top-up is still off. Try again.';
          return;
        }
      }
      if (statusEl) statusEl.textContent = `Done — ${chargeBody.credits} credits added. Auto top-up is on.`;
      setTimeout(() => this.refreshAndMaybeResumeNoActions(), 1500);
    } catch {
      if (statusEl) statusEl.textContent = 'Something went wrong — auto top-up was not changed. Try again.';
    }
  }

  createNoActionsCard() {
    const card = document.createElement('div');
    card.className = 'credits-inline-card';
    card.id = 'credits-inline-card';
    card.innerHTML = `
      <p class="cic-kicker">${escapeHtml(this.getNoActionsKickerText())}</p>
      <div class="cic-card">
        <div class="cic-logo"><img src="icon.png" alt="Ropilot" /></div>
        <h2 class="cic-title">Keep building with Ropilot Credits</h2>
        <p class="cic-sub">One-time top-up &middot; applied instantly</p>
        <button type="button" class="cic-cta" id="cic-upgrade">
          Get 30 credits &middot; <span class="cic-amt">$8</span>
          <svg class="cic-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
        </button>
        <p class="cic-resume-status">${escapeHtml(this.getNoActionsResumeStatusText())}</p>
        <div class="cic-auto" id="cic-auto"></div>
        <div class="cic-footer">
          <button type="button" class="cic-resume-now" id="cic-resume-now">Check credits</button>
          <button type="button" class="cic-later" id="cic-later">Maybe later</button>
        </div>
      </div>
      ${INLINE_INVITE_PROMO_MARKUP}
    `;
    this.postWallEvent('shown', 'no_actions');
    card.querySelector('#cic-upgrade')?.addEventListener('click', () => {
      this.postWallEvent('checkout_opened', 'no_actions');
      electronAPI()?.openExternal(`${this.app.config.siteUrl}/pricing`);
    });
    card.querySelector('#cic-resume-now')?.addEventListener('click', () => {
      this.refreshAndMaybeResumeNoActions();
    });
    card.querySelector('#cic-later')?.addEventListener('click', () => {
      this.postWallEvent('dismissed', 'no_actions');
      if (this.app.noActionsUpgradeToRopilotCreditsPending !== true) {
        // Remember the dismissal so this turn's failure can't re-show the
        // wall (or auto-resume); forgotten on the next user-initiated send.
        this.app.noActionsWallDismissedKey = this.getNoActionsWallTurnKey();
      }
      this.hideNoActionsModal();
    });
    setTimeout(() => {
      this.updateNoActionsCard();
      this.app.settings?.updateInviteWidgetVisibility?.(this.app.isUseRopilotCreditsEnabled?.() === true || this.app.useRopilotCredits === true);
    }, 0);
    this.renderWallAutoRefillSection(card);
    return card;
  }

  /**
   * Auto top-up section of the credit wall. Three states:
   *  - enabled            -> quiet status line (refill should already be running)
   *  - consented + card   -> one-tap "buy + re-enable" button
   *  - otherwise          -> link to checkout with the opt-in pre-focused
   * Always opt-in; nothing here charges without a click on a labeled button.
   */
  async renderWallAutoRefillSection(card, authoritativeState) {
    const host = card.querySelector('#cic-auto');
    if (!host) return;
    const state = authoritativeState === undefined ? await this.fetchAutoRefillState() : authoritativeState;
    const siteUrl = siteUrlFromConfig(this.app.config);
    if (state?.enabled) {
      const price = (state.pack_price_cents / 100).toFixed(0);
      host.innerHTML = `
        <p class="cic-auto-on">&#9889; Auto top-up is on &mdash; ${state.pack_credits} credits ($${price}) purchase automatically when you drop below ${state.threshold_credits}.
        <button type="button" class="cic-auto-manage" id="cic-auto-off">Turn off</button></p>
        <p class="cic-auto-hint" id="cic-auto-status" hidden></p>`;
      host.querySelector('#cic-auto-off')?.addEventListener('click', async () => {
        const button = host.querySelector('#cic-auto-off');
        const status = host.querySelector('#cic-auto-status');
        const apiKey = typeof this.app.getEffectiveApiKey === 'function' ? this.app.getEffectiveApiKey() : this.app.apiKey;
        if (button) button.disabled = true;
        if (status) {
          status.hidden = false;
          status.textContent = 'Turning auto top-up off…';
        }
        try {
          const response = await fetch(`${siteUrl}/api/auto-refill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ action: 'disable' }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error('Auto top-up update failed');
          const nextState = body?.auto_refill;
          if (nextState) {
            this.app._autoRefillState = nextState;
            await this.renderWallAutoRefillSection(card, nextState);
          } else {
            host.innerHTML = '<p class="cic-auto-hint">Auto top-up is off.</p>';
          }
        } catch {
          if (button) button.disabled = false;
          if (status) status.textContent = 'Auto top-up could not be turned off. Try again.';
        }
      });
      return;
    }
    if (state?.has_consent && state?.has_customer) {
      const price = (state.pack_price_cents / 100).toFixed(0);
      host.innerHTML = `
        <button type="button" class="cic-cta cic-cta-auto" id="cic-auto-buy">
          &#9889; Get ${state.pack_credits} credits ($${price}) + turn auto top-up on
        </button>
        <p class="cic-auto-hint" id="cic-auto-status">Uses your saved card &middot; never see this wall again</p>`;
      host.querySelector('#cic-auto-buy')?.addEventListener('click', () => {
        this.postWallEvent('checkout_opened', 'no_actions');
        this.refillNowAndEnable(host.querySelector('#cic-auto-status'));
      });
      // One-tap is the better default for these users: promote it above
      // the one-time CTA and quiet the latter down.
      const mainCta = card.querySelector('#cic-upgrade');
      if (mainCta && mainCta.parentNode) {
        mainCta.parentNode.insertBefore(host, mainCta);
        mainCta.classList.add('cic-cta-secondary');
      }
      return;
    }
    host.innerHTML = `
      <button type="button" class="cic-auto-link" id="cic-auto-link">&#9889; Enable auto top-up &mdash; never see this wall again</button>`;
    host.querySelector('#cic-auto-link')?.addEventListener('click', () => {
      this.postWallEvent('checkout_opened', 'no_actions');
      electronAPI()?.openExternal(`${siteUrl}/pricing?auto_refill=1`);
    });
  }
}
