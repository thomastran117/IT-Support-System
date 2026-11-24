import {
  validateProposal,
  type AIProvider,
  type AnalysisRequest,
  type ValidatedProposal,
} from '@smartdesk/ai-analysis';

/**
 * A trivial keyword classifier used as a deterministic, offline stand-in provider.
 *
 * It is NOT an AI model and its score says nothing about any model. It exists so CI can run the whole
 * evaluation pipeline reproducibly with no network. Its keywords were written with the dataset in
 * view, so its score on that dataset is optimistic and must never be quoted as a benchmark.
 * It reads only the ticket text and the allowed category names it is given.
 */
const KEYWORDS: Record<string, readonly string[]> = {
  Hardware: [
    'printer',
    'monitor',
    'keyboard',
    'mouse',
    'battery',
    'laptop',
    'headset',
    'webcam',
    'camera',
    'dock',
    'docking',
    'phone',
    'handset',
    'cable',
    'screen',
    'power',
  ],
  Software: [
    'licence',
    'license',
    'install',
    'application',
    'app',
    'crash',
    'update',
    'spreadsheet',
    'macro',
    'browser',
    'extension',
    'editor',
    'antivirus',
    'activate',
  ],
  'Network/VPN': [
    'vpn',
    'wi-fi',
    'wifi',
    'wireless',
    'network',
    'internet',
    'dns',
    'remote',
    'connection',
    'packet',
    'bandwidth',
  ],
  'Access/Accounts': [
    'password',
    'account',
    'locked',
    'access',
    'permission',
    'login',
    'sign',
    'mailbox',
    'authenticator',
    'multi-factor',
    'starter',
  ],
};

const TEAM_FOR: Record<string, string> = {
  Hardware: 'Hardware & Devices',
  Software: 'Hardware & Devices',
  'Network/VPN': 'Network & Access',
  'Access/Accounts': 'Network & Access',
};

export function createKeywordBaseline(): AIProvider {
  return {
    name: 'baseline',
    async analyse(request: AnalysisRequest): Promise<ValidatedProposal> {
      const text = `${request.ticket.title} ${request.ticket.description}`.toLowerCase();
      const words = new Set(text.match(/[a-z][a-z-]*/g) ?? []);
      let best = request.allowedCategories[0];
      let bestScore = -1;
      for (const cat of request.allowedCategories) {
        const score = (KEYWORDS[cat.name] ?? []).filter((k) => words.has(k)).length;
        if (score > bestScore) {
          best = cat;
          bestScore = score;
        }
      }
      const team =
        request.allowedTeams.find((t) => t.name === TEAM_FOR[best?.name ?? '']) ??
        request.allowedTeams[0];
      return validateProposal(
        {
          categoryId: best?.id,
          teamId: team?.id,
          priority: 'MEDIUM',
          troubleshooting: 'Keyword baseline: not an AI model.',
        },
        request,
        'baseline:keyword-v1',
      );
    },
  };
}
