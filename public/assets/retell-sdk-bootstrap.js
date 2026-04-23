// Loads the Retell Web Client SDK as an ES module from esm.sh and parks it
// on `window` so our classic-script dashboard can use it without a bundler.
// CSP allows scripts + connections from esm.sh so this stays within policy.

// Diagnostic: count how many times this module is evaluated. If we ever see
// >1 on a single page load, we're double-loading the SDK.
if (typeof window.__agenticzRetellSdkLoadCount === 'number') {
  window.__agenticzRetellSdkLoadCount++;
} else {
  window.__agenticzRetellSdkLoadCount = 1;
}
console.log('[orb-sdk] bootstrap evaluated', {
  loadCount: window.__agenticzRetellSdkLoadCount,
  readyAlready: Boolean(window.AgenticzRetellWebClient),
});

import { RetellWebClient } from 'https://esm.sh/retell-client-js-sdk';
window.AgenticzRetellWebClient = RetellWebClient;
window.dispatchEvent(new CustomEvent('agenticz-retell-sdk-ready'));
console.log('[orb-sdk] bootstrap ready', {
  loadCount: window.__agenticzRetellSdkLoadCount,
});
