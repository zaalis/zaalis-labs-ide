'use strict';

// Shared output-integrity layer for EVERY surface: classic chat (desktop UI and
// CLI), agent mode (desktop UI and CLI). All three go through /api/chat or
// /api/agent-chat, so both endpoints import this module and cannot drift apart.
//
// Two independent things can make an answer unusable, and neither was checked
// before:
//   1. the provider stopped because it hit the token ceiling (finish_reason
//      "length"): the text looks finished but is cut mid-sentence;
//   2. the model degenerated and emitted markdown scaffolding with no content
//      ("1.\n2.\n* \n* \n"), which rendered as a page of empty bullets.
// Both are now detected before an answer is ever shown or stored.

// Providers default to a small completion ceiling; a security report needs
// room. Applied to every provider that accepts an explicit cap.
const MAX_OUTPUT_TOKENS = 16000;

// Normalise the vocabulary used by OpenAI, Mistral, Grok, Kimi, Anthropic,
// Gemini and Ollama into one set of values.
function normalizeFinishReason(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!value) return '';
  if (['length', 'max_tokens', 'max_output_tokens', 'model_length'].includes(value)) return 'length';
  if (['stop', 'end_turn', 'stop_sequence', 'eos', 'complete'].includes(value)) return 'stop';
  if (['tool_calls', 'tool_use', 'function_call'].includes(value)) return 'tool_calls';
  if (['content_filter', 'safety', 'recitation', 'prohibited_content'].includes(value)) return 'content_filter';
  return value;
}

function isTruncated(raw) {
  return normalizeFinishReason(raw) === 'length';
}

const MARKER = /^\s*(?:[-*+]|\d+[.)]|#{1,6}|>|\|)+\s*/;
const DECORATION = /[*_`~\[\]()|:\-\s]/g;

// Counts what actually carries meaning. Fenced code is content, not decoration:
// a patch or a snippet is a real answer, so it must never look "empty" here.
function analyzeAnswer(text) {
  const body = String(text == null ? '' : text);
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  let proseChars = 0;
  let contentLines = 0;
  let emptyMarkers = 0;
  let repeatRun = 1;
  let longestRepeat = 0;
  let previous = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; contentLines++; continue; }
    if (inFence) {
      if (trimmed) { contentLines++; proseChars += trimmed.length; }
      continue;
    }
    if (trimmed) {
      repeatRun = trimmed === previous ? repeatRun + 1 : 1;
      if (repeatRun > longestRepeat) longestRepeat = repeatRun;
      previous = trimmed;
    } else {
      previous = null;
      repeatRun = 1;
      continue;
    }
    const hadMarker = MARKER.test(line);
    const stripped = line.replace(MARKER, '').replace(DECORATION, '').trim();
    if (!stripped) {
      if (hadMarker) emptyMarkers++;
      continue;
    }
    contentLines++;
    proseChars += stripped.length;
  }

  const chars = body.trim().length;
  const proseRatio = chars ? proseChars / chars : 0;
  let reason = '';
  // Deliberately conservative: each rule needs a clear majority of nothing, so
  // a terse but real answer is never rejected.
  if (emptyMarkers >= 4 && emptyMarkers >= contentLines) reason = 'structure_only';
  else if (chars >= 400 && contentLines === 0) reason = 'no_content';
  else if (chars >= 400 && proseRatio < 0.15) reason = 'no_prose';
  else if (longestRepeat >= 8) reason = 'repetition';

  return { chars, proseChars, proseRatio, contentLines, emptyMarkers, longestRepeat, degenerate: !!reason, reason };
}

function isDegenerate(text) {
  return analyzeAnswer(text).degenerate;
}

const REASON_LABELS = {
  fr: {
    structure_only: 'le modèle a produit une structure de liste sans contenu',
    no_content: 'le modèle n’a produit aucun contenu exploitable',
    no_prose: 'le modèle a produit de la mise en forme sans texte',
    repetition: 'le modèle a répété la même ligne en boucle',
  },
  en: {
    structure_only: 'the model produced list scaffolding with no content',
    no_content: 'the model produced no usable content',
    no_prose: 'the model produced formatting with no text',
    repetition: 'the model repeated the same line in a loop',
  },
};

function degenerateReasonLabel(reason, language = 'fr') {
  const table = REASON_LABELS[language === 'en' ? 'en' : 'fr'];
  return table[reason] || table.no_content;
}

function truncationNotice(language = 'fr') {
  return language === 'en'
    ? 'Note: the provider stopped this answer at the token ceiling, so it is cut off. Ask to continue to get the rest.'
    : 'Note : le fournisseur a coupé cette réponse à la limite de jetons, elle est donc incomplète. Demande la suite pour obtenir la fin.';
}

function degenerateNotice(reason, language = 'fr') {
  const why = degenerateReasonLabel(reason, language);
  return language === 'en'
    ? `The answer was discarded before display: ${why}. Nothing usable was produced, so no result is reported as valid.`
    : `La réponse a été écartée avant affichage : ${why}. Rien d’exploitable n’a été produit, aucun résultat n’est donc présenté comme valide.`;
}

// Instruction sent back to the model when its answer was cut at the ceiling.
function continuationPrompt(language = 'fr') {
  return language === 'en'
    ? '[ANSWER TRUNCATED] Your previous answer hit the output limit and was cut off. Produce it again in a more compact form: keep every finding, drop repetition and long quotes, and make sure the last section is complete.'
    : '[RÉPONSE TRONQUÉE] Ta réponse précédente a atteint la limite de sortie et a été coupée. Reproduis-la sous une forme plus compacte : conserve tous les constats, supprime les répétitions et les longues citations, et termine bien la dernière section.';
}

module.exports = {
  MAX_OUTPUT_TOKENS,
  normalizeFinishReason,
  isTruncated,
  analyzeAnswer,
  isDegenerate,
  degenerateReasonLabel,
  truncationNotice,
  degenerateNotice,
  continuationPrompt,
};
