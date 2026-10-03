import pg from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import type {
  Actor,
  Entity,
  Kind,
  CollaborationEvent,
} from "../protocol/src/index.ts";
import { assert } from "../domain/src/index.ts";
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://colag:colag@127.0.0.1:54329/colag",
  connectionTimeoutMillis: 2500,
});
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const entity = (r: any): Entity => ({
  id: r.id,
  projectId: r.project_id,
  kind: r.kind,
  data: r.data,
  version: r.version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export const event = (r: any): CollaborationEvent => ({
  seq: Number(r.seq),
  id: r.id,
  projectId: r.project_id,
  actorId: r.actor_id,
  type: r.type,
  resourceId: r.resource_id,
  payload: r.payload,
  timestamp: r.created_at.toISOString(),
});
export class Tx {
  constructor(
    public db: pg.PoolClient,
    public actor: Actor,
  ) {}
  async list(kind?: Kind) {
    const r = await this.db.query(
      "SELECT * FROM resources WHERE project_id=$1" +
        (kind ? " AND kind=$2" : "") +
        " ORDER BY created_at",
      [this.actor.projectId, ...(kind ? [kind] : [])],
    );
    return r.rows.map(entity);
  }
  async get(id: string, kind?: Kind) {
    const r = await this.db.query(
      "SELECT * FROM resources WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [id, this.actor.projectId],
    );
    assert(
      r.rows[0] && (!kind || r.rows[0].kind === kind),
      "Resource not found",
      "not_found",
      404,
    );
    return entity(r.rows[0]);
  }
  async create(
    kind: Kind,
    data: Record<string, any>,
    type = `${kind}.created`,
    id: string = randomUUID(),
  ) {
    const r = await this.db.query(
      "INSERT INTO resources(id,project_id,kind,data) VALUES($1,$2,$3,$4) RETURNING *",
      [id, this.actor.projectId, kind, data],
    );
    await this.emit(type, id, data);
    return entity(r.rows[0]);
  }
  async update(
    id: string,
    data: Record<string, any>,
    type: string,
    version?: number,
  ) {
    const old = await this.get(id);
    assert(
      version === undefined || version === old.version,
      "Stale resource version",
      "conflict",
      409,
    );
    const r = await this.db.query(
      "UPDATE resources SET data=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",
      [id, { ...old.data, ...data }],
    );
    await this.emit(type, id, data);
    return entity(r.rows[0]);
  }
  async emit(type: string, id: string, payload: Record<string, any>) {
    await this.db.query(
      "INSERT INTO events(id,project_id,actor_id,type,resource_id,payload) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), this.actor.projectId, this.actor.id, type, id, payload],
    );
  }
}
export async function transaction<T>(
  actor: Actor,
  key: string,
  body: unknown,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      actor.projectId,
    ]);
    const fingerprint = hash(JSON.stringify(body));
    const prior = await db.query(
      "SELECT * FROM commands WHERE actor_id=$1 AND key=$2",
      [actor.id, key],
    );
    if (prior.rows[0]) {
      assert(
        prior.rows[0].fingerprint === fingerprint,
        "Idempotency key reused for different command",
        "conflict",
        409,
      );
      await db.query("COMMIT");
      return prior.rows[0].result;
    }
    const result = await fn(new Tx(db, actor));
    await db.query("INSERT INTO commands VALUES($1,$2,$3,$4)", [
      actor.id,
      key,
      fingerprint,
      JSON.stringify(result ?? null),
    ]);
    await db.query("COMMIT");
    return result;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function migrate() {
  for (const file of ["001_initial.sql", "002_identity.sql"])
    await pool.query(
      await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8"),
    );
}
if (process.argv[1]?.endsWith("/database/src.ts")) {
  await migrate();
  await pool.end();
  console.log("Database migrated");
}
