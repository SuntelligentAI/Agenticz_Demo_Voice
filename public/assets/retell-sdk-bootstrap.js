// Loads the Retell Web Client SDK as an ES module from esm.sh and parks it
// on `window` so our classic-script dashboard can use it without a bundler.
// CSP allows scripts + connections from esm.sh so this stays within policy.

import { RetellWebClient } from 'https://esm.sh/retell-client-js-sdk';
window.AgenticzRetellWebClient = RetellWebClient;
window.dispatchEvent(new CustomEvent('agenticz-retell-sdk-ready'));
