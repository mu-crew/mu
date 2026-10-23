PRAGMA journal_mode=WAL;
CREATE TABLE machine_identity(id INTEGER PRIMARY KEY CHECK(id=1), machine_id TEXT, last_wall INTEGER, last_counter INTEGER);
INSERT INTO machine_identity VALUES(1,'m1',0,0);
-- context lives in MAIN schema, one row; only meaningful inside a write txn
CREATE TABLE op_ctx(id INTEGER PRIMARY KEY CHECK(id=1), group_id TEXT, actor TEXT, intent TEXT, applying INTEGER NOT NULL DEFAULT 0, now_ms INTEGER);
INSERT INTO op_ctx(id) VALUES(1);
CREATE TABLE tasks(id INTEGER PRIMARY KEY, local_id TEXT UNIQUE, status TEXT, title TEXT);
CREATE TABLE ops(seq INTEGER PRIMARY KEY, hlc TEXT, machine_id TEXT, group_id TEXT, actor TEXT, intent TEXT, key TEXT, op TEXT, payload TEXT);
CREATE TRIGGER cap_tasks_upd AFTER UPDATE ON tasks
WHEN (SELECT applying FROM op_ctx)=0 AND (NEW.status IS NOT OLD.status OR NEW.title IS NOT OLD.title)
BEGIN
  UPDATE op_ctx SET now_ms = CAST(unixepoch('subsec')*1000 AS INTEGER);
  UPDATE machine_identity SET last_wall=MAX(last_wall,(SELECT now_ms FROM op_ctx)),
    last_counter=CASE WHEN (SELECT now_ms FROM op_ctx)>last_wall THEN 0 ELSE last_counter+1 END;
  INSERT INTO ops(hlc,machine_id,group_id,actor,intent,key,op,payload)
  SELECT printf('%015d.%06d.%s',m.last_wall,m.last_counter,m.machine_id), m.machine_id,
         COALESCE(c.group_id, lower(hex(randomblob(8)))), c.actor, c.intent, NEW.local_id, 'put',
         CASE WHEN NEW.status IS NOT OLD.status THEN json_object('status',NEW.status) ELSE json_object('title',NEW.title) END
  FROM machine_identity m, op_ctx c;
END;
CREATE TRIGGER cap_tasks_ins AFTER INSERT ON tasks WHEN (SELECT applying FROM op_ctx)=0
BEGIN
  UPDATE op_ctx SET now_ms = CAST(unixepoch('subsec')*1000 AS INTEGER);
  UPDATE machine_identity SET last_wall=MAX(last_wall,(SELECT now_ms FROM op_ctx)),
    last_counter=CASE WHEN (SELECT now_ms FROM op_ctx)>last_wall THEN 0 ELSE last_counter+1 END;
  INSERT INTO ops(hlc,machine_id,group_id,actor,intent,key,op,payload)
  SELECT printf('%015d.%06d.%s',m.last_wall,m.last_counter,m.machine_id), m.machine_id,
         COALESCE(c.group_id, lower(hex(randomblob(8)))), c.actor, c.intent, NEW.local_id,'put',
         json_object('status',NEW.status,'title',NEW.title) FROM machine_identity m, op_ctx c;
END;
