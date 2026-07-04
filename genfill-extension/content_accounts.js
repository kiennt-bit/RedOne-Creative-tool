// content_accounts.js — auto-fill the shared Google account on the
// accounts.google.com login form, so a team member signs into the shared
// Flow account WITHOUT typing (or being shown) the email/password.
//
// It only acts when the member explicitly triggered "Đăng nhập tài khoản chung"
// (the background service worker holds a short-lived pending request). On any
// other visit to accounts.google.com it does nothing. The password is filled
// but never displayed, stored, or logged by this script.
//
// NOTE: this hides the credentials from normal use only. A technically skilled
// member can still read the filled value via DevTools — that's an inherent
// limit of client-side auto-fill (accepted trade-off).
(function () {
  if (!location.hostname.endsWith("accounts.google.com")) return;

  function setNativeValue(el, value) {
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (_) {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function waitFor(getter, timeoutMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let el = null;
        try { el = getter(); } catch (_) {}
        if (el) return resolve(el);
        if (Date.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  const emailField = () =>
    document.querySelector('input[type="email"]#identifierId')
    || document.querySelector('input[type="email"]')
    || document.querySelector('input[name="identifier"]');

  const passwordField = () =>
    document.querySelector('input[type="password"][name="Passwd"]')
    || document.querySelector('input[type="password"]');

  function clickNext() {
    for (const id of ["identifierNext", "passwordNext"]) {
      const c = document.getElementById(id);
      if (c) { (c.querySelector("button") || c).click(); return true; }
    }
    return false;
  }

  async function run(creds) {
    // EMAIL step (skipped automatically if we're already on the password page).
    const em = await waitFor(emailField, 8000);
    if (em && !em.value) {
      setNativeValue(em, creds.email);
      await new Promise((r) => setTimeout(r, 250));
      clickNext();
    }
    // PASSWORD step — appears after the email is submitted (same-page SPA or a
    // fresh navigation; either way we poll for it).
    const pw = await waitFor(passwordField, 15000);
    if (pw && !pw.value) {
      setNativeValue(pw, creds.password);
      await new Promise((r) => setTimeout(r, 250));
      clickNext();
    }
    try { chrome.runtime.sendMessage({ type: "GOOGLE_AUTOFILL_DONE" }); } catch (_) {}
  }

  // Only proceed if the background has a pending auto-fill request for us.
  try {
    chrome.runtime.sendMessage({ type: "GET_GOOGLE_AUTOFILL" }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok || !r.email) return;
      run({ email: r.email, password: r.password });
    });
  } catch (_) {}
})();
