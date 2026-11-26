import type { HourPoint } from "@/domain/analysis";
import type { Metric, Segment } from "@/domain/types";
import type { Db } from "../db/client";

/** Column names come from this allow-list only; values are always bind parameters. */
const METRIC_COLUMN: Record<Metric, string> = { searches: "searches", listing_views: "listing_views", leads: "leads" };

function segmentWhere(segment: Segment, params: unknown[]): string {
  const parts: string[] = [];
  if (segment.community) {
    params.push(segment.community);
    parts.push(`community = $${params.length}`);
  }
  if (segment.platform) {
    params.push(segment.platform);
    parts.push(`platform = $${params.length}`);
  }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

export function telemetryRepository(db: Pick<Db, "query">) {
  return {
    async hourlySeries(dataset: string, metric: Metric, segment: Segment): Promise<HourPoint[]> {
      const params: unknown[] = [dataset];
      const where = segmentWhere(segment, params);
      return db.query<HourPoint>(
        `SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') AS ts, sum(${METRIC_COLUMN[metric]})::int AS value
         FROM metric_hourly WHERE dataset = $1${where} GROUP BY ts ORDER BY ts`,
        params,
      );
    },

    async changes(dataset: string, from: string, to: string) {
      return db.query<{ kind: "deploy" | "flag"; key: string; platform: string | null; ts: string; description: string }>(
        `SELECT 'deploy' AS kind, service || ' ' || version AS key, platform, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"') AS ts, description
           FROM deployments WHERE dataset = $1 AND ts >= $2 AND ts <= $3
         UNION ALL
         SELECT 'flag', flag_key, platform, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:00"Z"'),
                CASE WHEN new_enabled THEN 'enabled' ELSE 'disabled' END || ' by ' || actor || coalesce(': ' || nullif(note, ''), '')
           FROM flag_changes WHERE dataset = $1 AND ts >= $2 AND ts <= $3
         ORDER BY 4`,
        [dataset, from, to],
      );
    },

    async pipelineFailures(dataset: string, from: string, to: string) {
      return db.query<{ hour: string; status: string; rowsReceived: number }>(
        `SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, status, rows_received AS "rowsReceived"
         FROM pipeline_runs WHERE dataset = $1 AND hour >= $2 AND hour < $3 AND status <> 'ok' ORDER BY hour`,
        [dataset, from, to],
      );
    },

    async supplyByAgency(dataset: string, community: string | undefined, before: string, after: string) {
      const params: unknown[] = [dataset, before, after];
      const c = community ? (params.push(community), ` AND community = $${params.length}`) : "";
      return db.query<{ agency: string; before: number; after: number }>(
        `SELECT agency,
                round(avg(active_listings) FILTER (WHERE day < $2::date))::int AS before,
                round(avg(active_listings) FILTER (WHERE day >= $3::date))::int AS after
         FROM agency_supply_daily WHERE dataset = $1${c} GROUP BY agency ORDER BY agency`,
        params,
      );
    },

    async listingSamples(dataset: string, community: string, limit: number) {
      return db.query<{ agency: string; title: string; description: string; status: string }>(
        `SELECT agency, title, description, status FROM listing_samples
         WHERE dataset = $1 AND community = $2 ORDER BY (status = 'deactivated') DESC, id LIMIT $3`,
        [dataset, community, limit],
      );
    },

    async flag(dataset: string, key: string) {
      const [row] = await db.query<{ flagKey: string; enabled: boolean; platform: string | null; description: string }>(
        `SELECT flag_key AS "flagKey", enabled, platform, description FROM feature_flags WHERE dataset = $1 AND flag_key = $2`,
        [dataset, key],
      );
      return row;
    },
  };
}
export type TelemetryRepository = ReturnType<typeof telemetryRepository>;
