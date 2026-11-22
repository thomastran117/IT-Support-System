/**
 * Deterministic "look at this first" cue for tickets that read as high risk. It exists so that when
 * AI is unavailable a technician still gets a prompt to prioritise by hand. It is NOT a
 * recommendation: it is never stored, never changes a ticket and never pretends to be AI output.
 * Reasons are fixed labels and never echo ticket text.
 */
const RULES: { label: string; re: RegExp }[] = [
  {
    label: 'Possible security incident',
    re: /\b(ransomware|malware|virus|phishing|breach(?:ed)?|compromised|hacked|unauthori[sz]ed access|data leak|stolen)\b/i,
  },
  {
    label: 'Possible outage affecting many users',
    re: /\b(outage|all users|everyone|whole (?:office|team|company)|company[- ]wide|site (?:is )?down|network (?:is )?down|server (?:is )?down|production (?:is )?down)\b/i,
  },
  {
    label: 'Requester cannot work',
    re: /\b(cannot work|can't work|unable to work|locked out|no access to (?:email|anything)|completely down)\b/i,
  },
  {
    label: 'Marked urgent',
    re: /\b(urgent(?:ly)?|asap|emergency|critical|immediately)\b/i,
  },
];

export interface ManualCue {
  highRisk: boolean;
  reasons: string[];
}

export function manualRiskCue(title: string, description: string): ManualCue {
  const text = `${title}\n${description}`;
  const reasons = RULES.filter((r) => r.re.test(text)).map((r) => r.label);
  return { highRisk: reasons.length > 0, reasons };
}
