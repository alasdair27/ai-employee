import pg from 'pg';
const pool = process.env.DATABASE_URL ? new pg.Pool({connectionString:process.env.DATABASE_URL, max:3, connectionTimeoutMillis:5000}) : null;
export const databaseConfigured = Boolean(pool);
export async function initialize() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id BIGSERIAL PRIMARY KEY,
    channel TEXT NOT NULL,
    user_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_progress','blocked','completed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}
export async function addTasks(channel,userId,descriptions) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const created=[];
    for (const description of descriptions) {
      const r=await client.query('INSERT INTO tasks(channel,user_id,description) VALUES($1,$2,$3) RETURNING id,description,status',[channel,userId,description]);
      created.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return created;
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
export async function listTasks(channel,userId) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const r=await pool.query("SELECT id,description,status FROM tasks WHERE channel=$1 AND user_id=$2 AND status NOT IN ('cancelled') ORDER BY id DESC LIMIT 30",[channel,userId]);
  return r.rows.reverse();
}
export async function updateTask(channel,userId,id,status) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  const r=await pool.query("UPDATE tasks SET status=$4,updated_at=now() WHERE id=$1 AND channel=$2 AND user_id=$3 AND status NOT IN ('completed','cancelled') RETURNING id,description,status",[id,channel,userId,status]);
  return r.rows[0];
}
