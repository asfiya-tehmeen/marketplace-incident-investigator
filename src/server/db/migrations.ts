export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "001_telemetry",
    sql: `
-- Every telemetry row belongs to a simulated "world" (dataset). Tools are scoped
-- to the investigation's dataset by the server; the model cannot choose it.
CREATE TABLE datasets (
  id           text PRIMARY KEY,
  title        text NOT NULL,
  description  text NOT NULL,
  default_task text NOT NULL,
  simulated    boolean NOT NULL DEFAULT true
);

CREATE TABLE metric_hourly (
  dataset        text NOT NULL REFERENCES datasets(id),
  ts             timestamptz NOT NULL,
  community      text NOT NULL,
  platform       text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  searches       integer NOT NULL CHECK (searches >= 0),
  listing_views  integer NOT NULL CHECK (listing_views >= 0),
  leads          integer NOT NULL CHECK (leads >= 0),
  PRIMARY KEY (dataset, ts, community, platform)
);

CREATE TABLE deployments (
  id          serial PRIMARY KEY,
  dataset     text NOT NULL REFERENCES datasets(id),
  ts          timestamptz NOT NULL,
  service     text NOT NULL,
  platform    text CHECK (platform IN ('ios', 'android', 'web')),
  version     text NOT NULL,
  description text NOT NULL
);

CREATE TABLE feature_flags (
  dataset     text NOT NULL REFERENCES datasets(id),
  flag_key    text NOT NULL,
  enabled     boolean NOT NULL,
  platform    text CHECK (platform IN ('ios', 'android', 'web')),
  description text NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (dataset, flag_key)
);

CREATE TABLE flag_changes (
  id          serial PRIMARY KEY,
  dataset     text NOT NULL REFERENCES datasets(id),
  ts          timestamptz NOT NULL,
  flag_key    text NOT NULL,
  platform    text,
  old_enabled boolean NOT NULL,
  new_enabled boolean NOT NULL,
  actor       text NOT NULL,
  note        text NOT NULL DEFAULT ''
);

CREATE TABLE pipeline_runs (
  dataset        text NOT NULL REFERENCES datasets(id),
  hour           timestamptz NOT NULL,
  source         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  rows_received  integer NOT NULL,
  PRIMARY KEY (dataset, hour, source)
);

CREATE TABLE agency_supply_daily (
  dataset          text NOT NULL REFERENCES datasets(id),
  day              date NOT NULL,
  community        text NOT NULL,
  agency           text NOT NULL,
  active_listings  integer NOT NULL CHECK (active_listings >= 0),
  PRIMARY KEY (dataset, day, community, agency)
);

CREATE TABLE listing_samples (
  id          serial PRIMARY KEY,
  dataset     text NOT NULL REFERENCES datasets(id),
  community   text NOT NULL,
  agency      text NOT NULL,
  title       text NOT NULL,
  description text NOT NULL,
  status      text NOT NULL CHECK (status IN ('active', 'deactivated'))
);
`,
  },
  {
    id: "002_investigations",
    sql: `
CREATE TABLE investigations (
  id           text PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  dataset      text NOT NULL REFERENCES datasets(id),
  task         text NOT NULL,
  provider     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'needs_info', 'insufficient_evidence', 'failed')),
  problem      jsonb,
  report       jsonb,
  assessments  jsonb NOT NULL DEFAULT '[]',
  usage        jsonb NOT NULL DEFAULT '{}',
  outcome_note text
);
CREATE INDEX investigations_created_idx ON investigations (created_at DESC);

-- Append-only trace: every decision, validation failure, tool call and result.
CREATE TABLE investigation_steps (
  id                bigserial PRIMARY KEY,
  investigation_id  text NOT NULL REFERENCES investigations(id),
  seq               integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL,
  payload           jsonb NOT NULL,
  UNIQUE (investigation_id, seq)
);

CREATE TABLE evidence (
  investigation_id  text NOT NULL REFERENCES investigations(id),
  id                text NOT NULL,
  tool              text NOT NULL,
  args              jsonb NOT NULL,
  summary           text NOT NULL,
  facts             jsonb NOT NULL,
  untrusted_text    text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (investigation_id, id)
);

CREATE TABLE action_proposals (
  id                text PRIMARY KEY,
  investigation_id  text NOT NULL REFERENCES investigations(id),
  dataset           text NOT NULL REFERENCES datasets(id),
  type              text NOT NULL CHECK (type IN ('rollback_feature_flag', 'create_incident_ticket')),
  params            jsonb NOT NULL,
  rationale         text NOT NULL,
  evidence_ids      text[] NOT NULL,
  reversible        boolean NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending', 'rejected', 'executed', 'failed', 'undone')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text,
  result            jsonb,
  undo_state        jsonb
);

CREATE TABLE tickets (
  id           serial PRIMARY KEY,
  dataset      text NOT NULL REFERENCES datasets(id),
  team         text NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  action_id    text REFERENCES action_proposals(id)
);

CREATE TABLE audit_log (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL,
  action    text NOT NULL,
  target    text NOT NULL,
  details   jsonb NOT NULL DEFAULT '{}'
);
`,
  },
];
