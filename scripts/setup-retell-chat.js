// Idempotent Retell setup for the Web Bot (text chat) demo.
//
// Creates a Retell chat agent on first run and re-PATCHes prompt + begin
// message on subsequent runs. The Retell public key (used by the browser
// widget) is managed in the Retell dashboard — this script only prints
// reminders; it does NOT try to create public keys via the API because
// Retell keys are typically dashboard-only and benefit from explicit
// reCAPTCHA configuration that also lives there.
//
// Never logs the API key.

import {
  createRetellLlm,
  updateRetellLlm,
  createChatAgent,
  updateChatAgent,
} from '../lib/retell.js';

const AGENT_NAME = 'AGENTICZ_WEBCHAT_DO_NOT_EDIT';

const BEGIN_MESSAGE = `Hi! I'm {{agent_name}} from {{company_name}}. How can I help?`;

const GENERAL_PROMPT = `You are {{agent_name}}, a text chat assistant for {{company_name}}.

ABOUT THE COMPANY
{{company_description}}

WHY YOU ARE ON THIS WIDGET
{{call_purpose}}

STYLE
- Warm, professional, concise. British English.
- Text messages stay short — 1-3 sentences where possible.
- Sound like a real person working at the company, not a script.
- Never say you are an AI unless directly asked; if asked, be honest and brief.
- Never invent details beyond ABOUT THE COMPANY.

OBJECTIVE
Answer the visitor's questions. If they want to book a meeting, guide them through a quick simulated booking flow.

FLOW
1. Open warmly: "Hi! I'm {{agent_name}} from {{company_name}}. How can I help?"
2. Listen and respond using ABOUT THE COMPANY.
3. If unsure, say so honestly and offer to connect them with someone.
4. If they want a meeting: ask when they're free (morning/afternoon, specific day). Propose a specific slot. Confirm clearly.
5. After confirming: tell them they'll see a booking form below the chat to finalize. (The page will show a Cal.com iframe.)

DEMO NOTE (internal)
No real calendar is connected. You are simulating the booking for a demo. After you confirm a time in chat, the page will show a real Cal.com booking iframe where the user completes the booking themselves.

RULES
- Keep messages short.
- If the user is confused, gently re-introduce yourself.
- Do not ask for payment details or sensitive data.
`;

function required(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`${name} is not set`);
  }
  return v;
}

required('RETELL_API_KEY');

const existingLlmId = process.env.RETELL_CHAT_LLM_ID || '';
const existingAgentId = process.env.RETELL_CHAT_AGENT_ID || '';

// --- LLM (prompt + begin message) ----------------------------------------

const llmBody = {
  general_prompt: GENERAL_PROMPT,
  begin_message: BEGIN_MESSAGE,
};

let llmId = existingLlmId;
if (llmId) {
  console.log(`Updating existing Retell LLM ${llmId}…`);
  await updateRetellLlm(llmId, llmBody);
} else {
  console.log('Creating new Retell LLM for chat…');
  const llm = await createRetellLlm(llmBody);
  llmId = llm?.llm_id || llm?.id;
  if (!llmId) {
    throw new Error(
      'create-retell-llm returned no llm_id: ' +
        JSON.stringify(llm).slice(0, 300),
    );
  }
  console.log(`Created LLM: ${llmId}`);
}

// --- Chat agent ----------------------------------------------------------

const agentBody = {
  agent_name: AGENT_NAME,
  response_engine: { type: 'retell-llm', llm_id: llmId },
};

let agentId = existingAgentId;

if (agentId) {
  console.log(`Updating existing Retell chat agent ${agentId}…`);
  await updateChatAgent(agentId, agentBody);
} else {
  console.log('Creating new Retell chat agent…');
  const agent = await createChatAgent(agentBody);
  agentId = agent?.chat_agent_id || agent?.agent_id || agent?.id;
  if (!agentId) {
    throw new Error(
      'create-chat-agent returned no agent_id: ' +
        JSON.stringify(agent).slice(0, 300),
    );
  }
  console.log(`Created chat agent: ${agentId}`);
}

console.log('');
console.log('Retell chat agent setup complete.');
console.log(`  Agent: ${agentId}`);
console.log(`  LLM:   ${llmId}`);
console.log('');
if (!existingAgentId || !existingLlmId) {
  console.log('NEXT — in this exact order:');
  console.log('');
  console.log(
    '1. In the Retell dashboard → Public Keys, create a new public key ' +
      '(or reuse an existing one) and ENABLE reCAPTCHA protection on it.',
  );
  console.log(
    '   Docs: https://docs.retellai.com/accounts/public-keys',
  );
  console.log(
    '2. Paste the IDs + public key into .env AND Vercel ' +
      '(Production + Preview + Development):',
  );
  console.log('');
  console.log(`   RETELL_CHAT_AGENT_ID=${agentId}`);
  console.log(`   RETELL_CHAT_LLM_ID=${llmId}`);
  console.log('   RETELL_PUBLIC_KEY=<from Retell dashboard>');
  console.log('');
  console.log(
    '3. Make sure GOOGLE_RECAPTCHA_SITE_KEY is also set locally and in Vercel.',
  );
}
