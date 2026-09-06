// CHAT LLM SELECTION — the operator picks which model answers, and the app never guesses.
//
// WHAT THIS REPLACES. `pickChatBackend` decided silently from a heuristic:
//
//     acct.capability !== "swarm" && OPENAI_COMPAT_TYPES.has(type) && hasSecret && baseUrl
//         ? "adapter" : "cli"
//
// Two things were wrong with it, and the second is the serious one:
//   1. PROBING AN ACCOUNT EJECTED IT FROM CHAT. Measuring tool support upgrades an account
//      to capability:"swarm" — which the rule read as "not for chat" — so a GOOD action
//      (unlocking the engine) silently moved chat somewhere else.
//   2. Nothing ever SAID SO. The operator added an OpenRouter key, watched replies arrive
//      from the Claude CLI, and no surface named the decision. A routing rule the operator
//      cannot see or override is the app choosing for them.
//
// THE CONTRACT NOW:
//   • An EXPLICIT choice always wins, and is never second-guessed — including for
//     swarm-capable accounts, which the old rule refused outright.
//   • With NO choice recorded we return `ask` and NAME the options. Ask once; the answer is
//     remembered. We never silently pick one and hope.
//   • A choice we cannot honour (deleted account, missing key, missing endpoint) also
//     returns `ask` WITH THE REASON — never a route that will fail at the provider, and
//     never a quiet fallback to a different model than the one the operator picked.
//
// Engine dispatch is UNAFFECTED: it keeps using the ACTIVE account via engineDispatch.
// Chat and engine are separate choices on purpose — one key can be right for one and wrong
// for the other.

import { OPENAI_COMPAT_TYPES } from "./providers/adapters/openai-compat.mjs";

/** Can this account serve chat, and how? → { via, usable, why }. Never throws. */
function classify(a) {
  if (!a || typeof a !== "object") return { via: null, usable: false, why: "not an account" };
  const type = String(a.providerType || "");
  if (OPENAI_COMPAT_TYPES.has(type)) {
    if (a.hasSecret !== true) return { via: "adapter", usable: false, why: "no API key stored for this account" };
    if (typeof a.baseUrl !== "string" || !a.baseUrl) return { via: "adapter", usable: false, why: "no base URL set for this account" };
    return { via: "adapter", usable: true, why: null };
  }
  // Claude (subscription or api_key) drives the local Claude CLI.
  if (type === "claude") return { via: "cli", usable: true, why: null };
  return { via: null, usable: false, why: `provider '${type || "unknown"}' cannot serve chat` };
}

/**
 * chatChoices(accounts) → what the picker renders.
 *
 * An UNUSABLE account is still listed, marked with the reason. Hiding it would leave the
 * operator hunting for an account they know they added.
 *
 * Carries identity + routing only — never a secret value.
 */
export function chatChoices(accounts) {
  const list = Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === "object" && a.id) : [];
  return list.map((a) => {
    const c = classify(a);
    return {
      id: String(a.id),
      label: String(a.label || a.id),
      providerType: String(a.providerType || ""),
      model: a.model ?? null,
      via: c.via,
      usable: c.usable,
      why: c.why,
    };
  });
}

/**
 * resolveChatRoute({ accounts, chatAccountId }) →
 *   { mode: "adapter" | "cli" | "ask", account?, choices?, reason }
 *
 * `ask` is a first-class outcome, not an error: it means the operator has not chosen yet,
 * or the recorded choice can no longer be honoured. Either way the caller shows the picker.
 */
export function resolveChatRoute(input) {
  const accounts = Array.isArray(input?.accounts)
    ? input.accounts.filter((a) => a && typeof a === "object" && a.id)
    : [];
  const chosenId = typeof input?.chatAccountId === "string" && input.chatAccountId ? input.chatAccountId : null;
  const choices = chatChoices(accounts);

  if (!chosenId) {
    // ASKING IS FOR AMBIGUITY, and the first cut of this got it wrong: it asked whenever
    // nothing was recorded, which broke chat on every existing single-account install (17
    // suite failures) and posed a question with exactly one possible answer.
    //
    //   0 usable → the pre-feature CLI fallback. Not a choice; just an install with no
    //              account, which must behave exactly as it did before this feature.
    //   1 usable → use it. There is nothing to choose between, and the operator's original
    //              complaint was never "you picked my only account" — it was "you picked
    //              something ELSE and never said so". The picker still shows what is routing.
    //   2+       → a real fork. ASK, and name the options.
    const usable = choices.filter((c) => c.usable);
    if (usable.length === 0) {
      return { mode: "cli", account: null, choices, reason: "no usable chat account — falling back to the local Claude CLI" };
    }
    if (usable.length === 1) {
      const only = accounts.find((a) => String(a.id) === usable[0].id) || null;
      return { mode: usable[0].via, account: only, choices, reason: `chat routed to '${usable[0].label}' — the only usable account` };
    }
    return { mode: "ask", choices, reason: "no chat model chosen yet — pick which LLM should answer" };
  }

  const account = accounts.find((a) => String(a.id) === chosenId) || null;
  if (!account) {
    // Do NOT fall back to another account: answering from a model the operator did not
    // pick is the exact silent substitution this module exists to stop.
    return { mode: "ask", choices, reason: `the chosen chat account is no longer present — select another` };
  }

  const c = classify(account);
  if (!c.usable) {
    return { mode: "ask", choices, account, reason: `'${account.label || account.id}' cannot serve chat: ${c.why}` };
  }
  return { mode: c.via, account, reason: `chat routed to '${account.label || account.id}' (${c.via})` };
}
