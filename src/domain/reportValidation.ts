import type { Verdict } from "./hypotheses";
import { Report, type Assessment, type Evidence } from "./types";

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Checks a provider's report against the evidence and the deterministic
 * assessments. Returns the parsed report or a list of problems that are fed
 * back to the provider on retry.
 */
export function validateReport(
  raw: unknown,
  evidence: readonly Evidence[],
  assessments: readonly Assessment[],
  v: Verdict,
): { ok: true; report: Report } | { ok: false; problems: string[] } {
  const parsed = Report.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 5).map((i) => `schema: ${i.path.join(".") || "report"}: ${i.message}`) };
  }
  const r = parsed.data;
  const problems: string[] = [];
  const ids = new Set(evidence.map((e) => e.id));
  const byId = new Map(evidence.map((e) => [e.id, e]));

  const cite = (list: string[], where: string) => {
    for (const id of list) if (!ids.has(id)) problems.push(`${where} cites ${id}, which does not exist.`);
  };
  r.claims.forEach((c, i) => cite(c.evidenceIds, `claims[${i}]`));
  r.alternatives.forEach((a, i) => cite(a.evidenceIds, `alternatives[${i}]`));
  r.recommendedActions.forEach((a, i) => cite(a.evidenceIds, `recommendedActions[${i}]`));

  // Conclusion must be what the evidence supports.
  if (v.kind === "conclusive" && r.conclusion !== v.hypothesis) {
    problems.push(`conclusion "${r.conclusion}" is not supported; the evidence supports "${v.hypothesis}".`);
  }
  if (v.kind === "ambiguous" && r.conclusion !== "undetermined" && !v.candidates.includes(r.conclusion as never)) {
    problems.push(`conclusion must be one of ${v.candidates.join(", ")} or "undetermined".`);
  }
  if (v.kind === "open" && r.conclusion !== "undetermined") {
    problems.push(`no hypothesis is supported yet, so conclusion must be "undetermined".`);
  }

  // Confidence can't exceed what the evidence allows.
  const cap = v.kind === "conclusive" ? v.confidenceCap : v.kind === "ambiguous" ? "medium" : "low";
  if (CONFIDENCE_RANK[r.confidence] > CONFIDENCE_RANK[cap]) problems.push(`confidence "${r.confidence}" exceeds the maximum "${cap}" for this evidence.`);

  // Alternatives can only be "rejected" if the evidence refuted them.
  const status = new Map(assessments.map((a) => [a.hypothesis, a.status]));
  r.alternatives.forEach((a) => {
    if (a.verdict === "rejected" && status.get(a.hypothesis) !== "refuted") {
      problems.push(`alternative "${a.hypothesis}" is marked rejected, but its status is "${status.get(a.hypothesis)}".`);
    }
  });

  // Every percentage in a claim must appear in the evidence it cites.
  r.claims.forEach((c, i) => {
    const allowed = c.evidenceIds.flatMap((id) => numbersIn(JSON.stringify(byId.get(id)?.facts ?? {}) + " " + (byId.get(id)?.summary ?? "")));
    for (const n of percentagesIn(c.text)) {
      if (!allowed.some((a) => Math.abs(Math.abs(a) - Math.abs(n)) <= 1)) {
        problems.push(`claims[${i}] states ${n}%, which is not in its cited evidence.`);
      }
    }
  });

  return problems.length ? { ok: false, problems } : { ok: true, report: r };
}

export function percentagesIn(text: string): number[] {
  return [...text.matchAll(/([+-−]?\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]!.replace("−", "-")));
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}
