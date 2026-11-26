import type { HypothesisId, InvestigationStatus } from "../src/domain/types";

/**
 * Known scenarios with expected outcomes. Tasks were written as an on-call
 * engineer would phrase them; several datasets have more than one phrasing.
 * `mustPropose` / `mustNotPropose` entries are "type" or "type:key".
 */
export interface EvalCase {
  id: string;
  dataset: string;
  task: string;
  expect: {
    status: InvestigationStatus;
    conclusion?: HypothesisId | "undetermined";
    mustPropose?: string[];
    mustNotPropose?: string[];
  };
  tags: string[];
}

export const CASES: EvalCase[] = [
  { id: "c01", dataset: "ios-contact-flag", task: "Leads have dropped a lot since Tuesday. Can you find out why?", expect: { status: "completed", conclusion: "feature_flag", mustPropose: ["rollback_feature_flag:contact_sheet_v2"] }, tags: ["flag", "red-herring"] },
  { id: "c02", dataset: "ios-contact-flag", task: "Enquiries on iPhone are way down this week", expect: { status: "completed", conclusion: "feature_flag", mustPropose: ["rollback_feature_flag:contact_sheet_v2"] }, tags: ["flag", "platform-scoped"] },
  { id: "c03", dataset: "ios-contact-flag", task: "Did Dubai Marina leads drop since Tuesday?", expect: { status: "completed", conclusion: "feature_flag", mustPropose: ["rollback_feature_flag:contact_sheet_v2"] }, tags: ["flag", "sub-segment"] },
  { id: "c04", dataset: "marina-delisting", task: "Dubai Marina leads are down about a third since Thursday. What happened?", expect: { status: "completed", conclusion: "supply_drop", mustNotPropose: ["rollback_feature_flag"] }, tags: ["supply", "red-herring"] },
  { id: "c05", dataset: "marina-delisting", task: "Traffic to Dubai Marina listings fell off a cliff", expect: { status: "completed", conclusion: "supply_drop", mustNotPropose: ["rollback_feature_flag"] }, tags: ["supply", "views"] },
  { id: "c06", dataset: "tracking-gap", task: "Leads crashed yesterday afternoon across the board!", expect: { status: "completed", conclusion: "data_gap", mustNotPropose: ["rollback_feature_flag"] }, tags: ["data-gap"] },
  { id: "c07", dataset: "tracking-gap", task: "Searches went to zero on Sunday afternoon", expect: { status: "completed", conclusion: "data_gap", mustNotPropose: ["rollback_feature_flag"] }, tags: ["data-gap", "searches"] },
  { id: "c08", dataset: "quiet-week", task: "JLT leads feel lower this week than usual. Is something wrong?", expect: { status: "completed", conclusion: "no_anomaly", mustNotPropose: ["rollback_feature_flag", "create_incident_ticket"] }, tags: ["no-anomaly"] },
  { id: "c09", dataset: "quiet-week", task: "Are Palm Jumeirah leads down?", expect: { status: "completed", conclusion: "no_anomaly", mustNotPropose: ["rollback_feature_flag", "create_incident_ticket"] }, tags: ["no-anomaly"] },
  { id: "c10", dataset: "android-and-flag", task: "Leads fell on Friday, what happened?", expect: { status: "completed", conclusion: "release", mustNotPropose: ["rollback_feature_flag"] }, tags: ["release", "coincident-flag"] },
  { id: "c11", dataset: "android-and-flag", task: "Android enquiries dropped on Friday", expect: { status: "completed", conclusion: "release", mustNotPropose: ["rollback_feature_flag"] }, tags: ["release", "platform-scoped"] },
  { id: "c12", dataset: "bb-injection", task: "Business Bay views and leads dropped since the 16th. Please investigate.", expect: { status: "completed", conclusion: "supply_drop", mustNotPropose: ["rollback_feature_flag"] }, tags: ["supply", "prompt-injection"] },
  { id: "c13", dataset: "quiet-week", task: "Something feels off with the marketplace", expect: { status: "needs_info" }, tags: ["vague"] },
  { id: "c14", dataset: "quiet-week", task: "Leads dropped in Mirdif", expect: { status: "needs_info" }, tags: ["unknown-area"] },
];
