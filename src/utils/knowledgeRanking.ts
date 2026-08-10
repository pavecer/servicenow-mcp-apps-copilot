import {
  KnowledgeRelevanceBand,
  RankedKnowledgeArticle,
  ServiceNowKnowledgeCandidate
} from "../types/servicenow";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "can", "do", "for", "from", "how", "i", "in",
  "is", "it", "me", "my", "of", "on", "or", "please", "the", "this", "to",
  "what", "when", "where", "with", "you"
]);

const FIELD_WEIGHTS = {
  title: 5,
  keywords: 4,
  shortDescription: 3,
  snippet: 1.5,
  category: 1,
  knowledgeBase: 1
} as const;

type WeightedField = keyof typeof FIELD_WEIGHTS;

function normalizeText(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter(token => token.length > 1 && !STOPWORDS.has(token));
}

function normalizedNativeScores(candidates: ServiceNowKnowledgeCandidate[]): Map<string, number> {
  const scored = candidates.filter(candidate => Number.isFinite(candidate.nativeScore));
  if (scored.length === 0) return new Map();
  const values = scored.map(candidate => candidate.nativeScore as number);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (maximum === minimum) return new Map();
  return new Map(scored.map(candidate => [
    candidate.sysId,
    ((candidate.nativeScore as number) - minimum) / (maximum - minimum)
  ]));
}

function lexicalScore(
  candidate: ServiceNowKnowledgeCandidate,
  queryTokens: string[],
  documentFrequency: Map<string, number>,
  documentCount: number
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const normalizedQuery = queryTokens.join(" ");

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as Array<[WeightedField, number]>) {
    const fieldText = normalizeText(candidate[field]);
    const fieldTokens = new Set(tokens(fieldText));
    let matched = 0;
    for (const token of queryTokens) {
      if (!fieldTokens.has(token)) continue;
      const frequency = documentFrequency.get(token) ?? 0;
      const inverseFrequency = Math.log(1 + (documentCount + 1) / (frequency + 1));
      score += weight * inverseFrequency;
      matched += 1;
    }
    if (matched > 0 && reasons.length < 3) {
      reasons.push(field === "shortDescription" ? "summary" : field.replace(/([A-Z])/g, " $1").toLowerCase());
    }
  }

  const normalizedTitle = normalizeText(candidate.title);
  if (normalizedQuery && normalizedTitle.includes(normalizedQuery)) {
    score *= 1.25;
    reasons.unshift("exact title phrase");
  }
  const combined = new Set(tokens([
    candidate.title,
    candidate.shortDescription,
    candidate.snippet,
    candidate.keywords
  ].join(" ")));
  if (queryTokens.length > 1 && queryTokens.every(token => combined.has(token))) score *= 1.1;

  return { score, reasons: [...new Set(reasons)].slice(0, 3) };
}

function band(rank: number, normalizedScore: number, normalizedLexical: number): KnowledgeRelevanceBand {
  if (rank === 1 && normalizedScore >= 0.45 && normalizedLexical >= 0.35) return "best";
  if (rank <= 3 && normalizedScore >= 0.25 && normalizedLexical >= 0.15) return "strong";
  return "related";
}

export function rankKnowledgeArticles(
  query: string,
  candidates: ServiceNowKnowledgeCandidate[],
  options: { limit?: number; excludeArticleSysIds?: string[] } = {}
): { articles: RankedKnowledgeArticle[]; rankingSource: "native_fused" | "local_lexical" } {
  const limit = Math.max(1, Math.min(options.limit ?? 5, 5));
  const excluded = new Set(options.excludeArticleSysIds ?? []);
  const deduplicated = new Map<string, ServiceNowKnowledgeCandidate>();
  for (const candidate of candidates) {
    if (!candidate.sysId || excluded.has(candidate.sysId)) continue;
    const key = candidate.number || normalizeText(candidate.title) || candidate.sysId;
    const current = deduplicated.get(key);
    if (!current || candidate.updatedOn > current.updatedOn) deduplicated.set(key, candidate);
  }

  const pool = [...deduplicated.values()];
  const queryTokens = [...new Set(tokens(query))];
  const documentFrequency = new Map<string, number>();
  for (const token of queryTokens) {
    const frequency = pool.filter(candidate => tokens([
      candidate.title,
      candidate.shortDescription,
      candidate.snippet,
      candidate.keywords,
      candidate.category,
      candidate.knowledgeBase
    ].join(" ")).includes(token)).length;
    documentFrequency.set(token, frequency);
  }

  const nativeScores = normalizedNativeScores(pool);
  const hasNativeScores = nativeScores.size > 0;
  const scored = pool.map(candidate => {
    const lexical = lexicalScore(candidate, queryTokens, documentFrequency, Math.max(pool.length, 1));
    return { candidate, lexicalScore: lexical.score, reasons: lexical.reasons };
  });
  const maximumLexical = Math.max(...scored.map(item => item.lexicalScore), 1);
  const fused = scored.map(item => {
    const normalizedLexical = item.lexicalScore / maximumLexical;
    const native = nativeScores.get(item.candidate.sysId);
    const positionPrior = 1 / Math.max(item.candidate.nativeRank, 1);
    const normalized = native == null
      ? normalizedLexical * 0.9 + positionPrior * 0.1
      : native * 0.6 + normalizedLexical * 0.4;
    return { ...item, normalized, normalizedLexical };
  }).sort((left, right) =>
    right.normalized - left.normalized
    || right.candidate.updatedOn.localeCompare(left.candidate.updatedOn)
    || left.candidate.nativeRank - right.candidate.nativeRank
  );

  return {
    rankingSource: hasNativeScores ? "native_fused" : "local_lexical",
    articles: fused.slice(0, limit).map((item, index) => ({
      ...item.candidate,
      rank: index + 1,
      score: Math.round(item.normalized * 1000) / 10,
      relevanceBand: band(index + 1, item.normalized, item.normalizedLexical),
      matchReasons: item.reasons
    }))
  };
}